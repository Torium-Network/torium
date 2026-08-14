import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { validateSignerRestore } from "./signer-state-guard.mjs";

test("accepts an exact or forward signer state without returning secret material", async () => {
  const fixture = await signerFixture();
  const same = await validateSignerRestore({
    currentHome: fixture.current,
    candidateHome: fixture.candidate,
    validatorStopped: true,
    trustedMaximumHeight: "43",
  });
  assert.equal(same.valid, true);
  assert.equal(same.samePosition, true);
  assert.equal(same.secretMaterialReturned, false);
  assert.equal(JSON.stringify(same).includes(fixture.privateValue), false);

  await writeState(
    fixture.candidate,
    signerState("43", 0, 1, fixture.privateKey)
  );
  const forward = await validateSignerRestore({
    currentHome: fixture.current,
    candidateHome: fixture.candidate,
    validatorStopped: true,
    trustedMaximumHeight: "43",
  });
  assert.equal(forward.samePosition, false);
  assert.deepEqual(forward.candidatePosition, {
    height: "43",
    round: 0,
    step: 1,
  });
});

test("accepts CometBFT's unsigned initial state with omitted optional fields", async () => {
  const fixture = await signerFixture();
  for (const home of [fixture.current, fixture.candidate]) {
    await writeState(home, signerState("0", 0, 0, fixture.privateKey));
  }
  const report = await validateSignerRestore({
    currentHome: fixture.current,
    candidateHome: fixture.candidate,
    validatorStopped: true,
    trustedMaximumHeight: "0",
  });
  assert.equal(report.valid, true);
  assert.deepEqual(report.currentPosition, { height: "0", round: 0, step: 0 });
});

test("rejects rollback and same-position conflicting sign data", async () => {
  const fixture = await signerFixture();
  await writeState(
    fixture.candidate,
    signerState("41", 0, 3, fixture.privateKey)
  );
  await assert.rejects(
    validateSignerRestore({
      currentHome: fixture.current,
      candidateHome: fixture.candidate,
      validatorStopped: true,
      trustedMaximumHeight: "43",
    }),
    /behind/u
  );

  await writeState(
    fixture.candidate,
    signerState("42", 0, 3, fixture.privateKey, randomBytes(32))
  );
  await assert.rejects(
    validateSignerRestore({
      currentHome: fixture.current,
      candidateHome: fixture.candidate,
      validatorStopped: true,
      trustedMaximumHeight: "43",
    }),
    /same signer position/u
  );
});

test("rejects invalid FilePV state, signature, bounds, and trusted ceiling", async () => {
  const fixture = await signerFixture();
  await writeState(fixture.candidate, {
    height: "43",
    round: 0,
    step: 0,
  });
  await assert.rejects(
    validateSignerRestore({
      currentHome: fixture.current,
      candidateHome: fixture.candidate,
      validatorStopped: true,
      trustedMaximumHeight: "43",
    }),
    /signed state requires/u
  );

  const badSignature = signerState("43", 0, 1, fixture.privateKey);
  badSignature.signature = Buffer.alloc(64, 5).toString("base64");
  await writeState(fixture.candidate, badSignature);
  await assert.rejects(
    validateSignerRestore({
      currentHome: fixture.current,
      candidateHome: fixture.candidate,
      validatorStopped: true,
      trustedMaximumHeight: "43",
    }),
    /does not verify/u
  );

  await writeState(fixture.candidate, {
    ...signerState("43", 0, 1, fixture.privateKey),
    round: 2_147_483_648,
  });
  await assert.rejects(
    validateSignerRestore({
      currentHome: fixture.current,
      candidateHome: fixture.candidate,
      validatorStopped: true,
      trustedMaximumHeight: "43",
    }),
    /int32/u
  );

  await writeState(
    fixture.candidate,
    signerState("44", 0, 1, fixture.privateKey)
  );
  await assert.rejects(
    validateSignerRestore({
      currentHome: fixture.current,
      candidateHome: fixture.candidate,
      validatorStopped: true,
      trustedMaximumHeight: "43",
    }),
    /exceeds trusted maximum/u
  );
});

test("rejects a different consensus identity and malformed key pair", async () => {
  const fixture = await signerFixture();
  const different = makeKey();
  await writeKey(fixture.candidate, different.key);
  await writeState(
    fixture.candidate,
    signerState("42", 0, 3, different.privateKey)
  );
  await assert.rejects(
    validateSignerRestore({
      currentHome: fixture.current,
      candidateHome: fixture.candidate,
      validatorStopped: true,
      trustedMaximumHeight: "43",
    }),
    /identity differs/u
  );

  const malformed = structuredClone(fixture.key);
  const privateBytes = Buffer.from(malformed.priv_key.value, "base64");
  privateBytes[0] ^= 0xff;
  malformed.priv_key.value = privateBytes.toString("base64");
  await writeKey(fixture.candidate, malformed);
  await assert.rejects(
    validateSignerRestore({
      currentHome: fixture.current,
      candidateHome: fixture.candidate,
      validatorStopped: true,
      trustedMaximumHeight: "43",
    }),
    /seed does not derive/u
  );
});

test("requires stopped evidence, strict permissions, and real files", async () => {
  const fixture = await signerFixture();
  await assert.rejects(
    validateSignerRestore({
      currentHome: fixture.current,
      candidateHome: fixture.candidate,
      validatorStopped: false,
      trustedMaximumHeight: "43",
    }),
    /stopped evidence/u
  );

  const candidateState = path.join(
    fixture.candidate,
    "data/priv_validator_state.json"
  );
  await chmod(candidateState, 0o644);
  await assert.rejects(
    validateSignerRestore({
      currentHome: fixture.current,
      candidateHome: fixture.candidate,
      validatorStopped: true,
      trustedMaximumHeight: "43",
    }),
    /0600/u
  );

  const symlinkFixture = await signerFixture();
  const linked = path.join(symlinkFixture.root, "linked-state.json");
  await writeFile(
    linked,
    `${JSON.stringify(signerState("42", 0, 3, symlinkFixture.privateKey))}\n`,
    { mode: 0o600 }
  );
  const statePath = path.join(
    symlinkFixture.candidate,
    "data/priv_validator_state.json"
  );
  await unlink(statePath);
  await symlink(linked, statePath);
  await assert.rejects(
    validateSignerRestore({
      currentHome: symlinkFixture.current,
      candidateHome: symlinkFixture.candidate,
      validatorStopped: true,
      trustedMaximumHeight: "43",
    }),
    /regular file/u
  );
});

async function signerFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "torium-signer-guard-"));
  const current = path.join(root, "current");
  const candidate = path.join(root, "candidate");
  const generated = makeKey();
  const key = generated.key;
  const state = signerState("42", 0, 3, generated.privateKey);
  for (const home of [current, candidate]) {
    await mkdir(path.join(home, "config"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(home, "data"), { recursive: true, mode: 0o700 });
    await writeKey(home, structuredClone(key));
    await writeState(home, state);
  }
  return {
    root,
    current,
    candidate,
    key,
    privateKey: generated.privateKey,
    privateValue: key.priv_key.value,
  };
}

function makeKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey
    .export({ format: "der", type: "pkcs8" })
    .subarray(-32);
  const publicBytes = publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  const privateBytes = Buffer.concat([seed, publicBytes]);
  return {
    privateKey,
    key: {
      address: createHash("sha256")
        .update(publicBytes)
        .digest()
        .subarray(0, 20)
        .toString("hex")
        .toUpperCase(),
      pub_key: {
        type: "tendermint/PubKeyEd25519",
        value: publicBytes.toString("base64"),
      },
      priv_key: {
        type: "tendermint/PrivKeyEd25519",
        value: privateBytes.toString("base64"),
      },
    },
  };
}

function signerState(
  height,
  round,
  step,
  privateKey,
  signbytes = Buffer.alloc(32, 9)
) {
  if (height === "0") {
    return { height, round: 0, step: 0 };
  }
  return {
    height,
    round,
    step,
    signature: sign(null, signbytes, privateKey).toString("base64"),
    signbytes: signbytes.toString("hex").toUpperCase(),
  };
}

async function writeKey(home, key) {
  await writeFile(
    path.join(home, "config/priv_validator_key.json"),
    `${JSON.stringify(key)}\n`,
    { mode: 0o600 }
  );
}

async function writeState(home, state) {
  await writeFile(
    path.join(home, "data/priv_validator_state.json"),
    `${JSON.stringify(state)}\n`,
    { mode: 0o600 }
  );
}
