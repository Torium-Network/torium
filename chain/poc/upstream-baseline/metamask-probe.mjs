import { createServer } from "node:http";
import { rm, writeFile } from "node:fs/promises";

import { HDNodeWallet } from "ethers";
import { chromium } from "playwright";

const extensionPath = process.env.METAMASK_EXTENSION_PATH;
const mnemonic = process.env.TORIUM_DEV_MNEMONIC;
const reportPath = process.env.REPORT_PATH;
const screenshotPath = process.env.SCREENSHOT_PATH;
const profilePath =
  process.env.METAMASK_PROFILE_PATH ?? "/tmp/torium-metamask-probe-profile";
const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const dappUrl = process.env.DAPP_URL ?? "http://127.0.0.1:18547";
const expectedChainId = Number(process.env.EVM_CHAIN_ID ?? "262144");
const networkName = process.env.TORIUM_NETWORK_NAME ?? "Torium PoC";
const nativeCurrencyName = process.env.NATIVE_CURRENCY_NAME ?? "Torium PoC";
const nativeCurrencySymbol = process.env.NATIVE_CURRENCY_SYMBOL ?? "TOR";
const rpcDisplayName = process.env.RPC_DISPLAY_NAME ?? "Torium local PoC";
const faucetUrl = process.env.FAUCET_URL;
const recipient =
  process.env.PROBE_RECIPIENT ?? "0x963EBDf2e1f8DB8707D05FC75bfeFFBa1B5BaC17";

if (!extensionPath) throw new Error("METAMASK_EXTENSION_PATH is required");
if (!mnemonic) throw new Error("TORIUM_DEV_MNEMONIC is required");
const expectedAccountAddress = HDNodeWallet.fromPhrase(mnemonic).address;

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  target: { rpcUrl, expectedChainId },
  wallet: { name: "MetaMask", version: process.env.METAMASK_VERSION ?? null },
  checks: {},
};

function startDappServer() {
  const url = new URL(dappUrl);
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(`<!doctype html>
      <html>
        <head><title>Torium MetaMask compatibility probe</title></head>
        <body><main><h1>Torium MetaMask compatibility probe</h1></main></body>
      </html>`);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(url.port), url.hostname, () => resolve(server));
  });
}

async function extensionIdFor(context) {
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent("serviceworker", { timeout: 30_000 });
  return new URL(worker.url()).host;
}

async function waitForTestId(page, testId, timeout = 30_000) {
  const locator = page.getByTestId(testId);
  await locator.waitFor({ state: "visible", timeout });
  return locator;
}

async function clickIfVisible(locator, timeout = 1_000) {
  try {
    await locator.waitFor({ state: "visible", timeout });
    await locator.click({ noWaitAfter: true, timeout });
    return true;
  } catch {
    return false;
  }
}

async function walletHomeVisible(page) {
  const expectedPrefix = expectedAccountAddress.slice(0, 7);
  return page.getByText(new RegExp(expectedPrefix, "iu")).first().isVisible();
}

async function onboard(page) {
  await page.bringToFront();
  await page.waitForLoadState("domcontentloaded");

  // Extension startup is asynchronous, especially after reopening a freshly
  // persisted profile. Wait until one of the stable wallet states appears
  // instead of treating the initial loading surface as fresh onboarding.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await walletHomeVisible(page)) return;
    if (
      (await page.getByTestId("unlock-page").isVisible()) ||
      (await page.getByTestId("onboarding-import-wallet").isVisible())
    ) {
      break;
    }
    const postOnboardingReady = page.locator(
      '[data-testid="onboarding-complete-done"]:visible'
    );
    if (await postOnboardingReady.isVisible()) {
      await postOnboardingReady.click({ force: true, noWaitAfter: true });
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (await walletHomeVisible(page)) return;
  if (await page.getByTestId("unlock-page").isVisible()) {
    await page.getByTestId("unlock-password").fill("torium-poc-only-password");
    await page.getByTestId("unlock-submit").click({ noWaitAfter: true });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await walletHomeVisible(page)) return;
      const postUnlockReady = page.locator(
        '[data-testid="onboarding-complete-done"]:visible'
      );
      if (await postUnlockReady.isVisible()) {
        await postUnlockReady.click({ force: true, noWaitAfter: true });
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(
      `MetaMask did not unlock:\n${await page.locator("body").innerText()}`
    );
  }
  const readyButton = page.locator(
    '[data-testid="onboarding-complete-done"]:visible'
  );
  if (await readyButton.isVisible()) {
    await readyButton.click({ force: true, noWaitAfter: true });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await walletHomeVisible(page)) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  await clickIfVisible(page.getByTestId("onboarding-terms-checkbox"), 2_000);
  await clickIfVisible(page.getByRole("checkbox"), 2_000);
  await waitForTestId(page, "onboarding-import-wallet").then((item) =>
    item.click()
  );

  await clickIfVisible(
    page.getByTestId("onboarding-import-with-srp-button"),
    5_000
  );
  await clickIfVisible(page.getByTestId("import-srp"), 5_000);

  await clickIfVisible(page.getByRole("button", { name: /no thanks/i }), 3_000);

  let input;
  try {
    input = await waitForTestId(page, "srp-input-import__srp-note");
  } catch (error) {
    console.error(
      `MetaMask onboarding state:\n${await page.locator("body").innerText()}`
    );
    const elements = page.locator("[data-testid]");
    const diagnostics = [];
    for (let index = 0; index < (await elements.count()); index += 1) {
      const element = elements.nth(index);
      diagnostics.push({
        testId: await element.getAttribute("data-testid"),
        role: await element.getAttribute("role"),
        disabled: await element.getAttribute("disabled"),
        ariaDisabled: await element.getAttribute("aria-disabled"),
        text: (await element.textContent())?.trim().slice(0, 120),
      });
    }
    console.error(diagnostics);
    throw error;
  }
  const words = mnemonic.trim().split(/\s+/u);
  if (![12, 15, 18, 21, 24].includes(words.length)) {
    throw new Error(`Unsupported recovery phrase length: ${words.length}`);
  }
  await input.fill(words[0]);
  await input.press("Space");
  for (let index = 1; index < words.length; index += 1) {
    const wordInput = await waitForTestId(
      page,
      `import-srp__srp-word-${index}`
    );
    await wordInput.fill(words[index]);
    await wordInput.press("Space");
  }

  await waitForTestId(page, "import-srp-confirm").then((item) => item.click());
  await waitForTestId(page, "create-password-new-input").then((item) =>
    item.fill("torium-poc-only-password")
  );
  await waitForTestId(page, "create-password-confirm-input").then((item) =>
    item.fill("torium-poc-only-password")
  );
  await waitForTestId(page, "create-password-terms").then((item) =>
    item.click()
  );
  await waitForTestId(page, "create-password-submit").then((item) =>
    item.click()
  );

  for (let attempt = 0; attempt < 24; attempt += 1) {
    const metrics = page.getByTestId("metametrics-checkbox");
    if (
      (await metrics.isVisible()) &&
      (await metrics.getAttribute("data-checked")) === "true"
    ) {
      await clickIfVisible(metrics, 1_000);
    }
    await clickIfVisible(
      page.locator('[data-testid="metametrics-i-agree"]:visible'),
      1_000
    );
    await clickIfVisible(
      page.locator('[data-testid="passkey-maybe-later-button"]:visible'),
      1_000
    );
    await clickIfVisible(
      page.locator('[data-testid="onboarding-complete-done"]:visible'),
      1_000
    );
    await clickIfVisible(
      page.locator('[data-testid="download-app-continue"]:visible'),
      1_000
    );
    if (await walletHomeVisible(page)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  try {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await walletHomeVisible(page)) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } catch (error) {
    console.error(
      `MetaMask post-onboarding state:\n${await page.locator("body").innerText()}`
    );
    throw error;
  }
}

async function waitForConfirmationPage(context, extensionId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const page of context.pages()) {
      if (
        page.isClosed() ||
        !page.url().startsWith(`chrome-extension://${extensionId}/`)
      ) {
        continue;
      }
      await page.waitForLoadState("domcontentloaded");
      const hasConfirmationControl =
        (await page
          .locator('[data-testid="confirmation-submit-button"]:visible')
          .count()) > 0 ||
        (await page
          .locator('[data-testid="page-container-footer-next"]:visible')
          .count()) > 0;
      const isConfirmationRoute =
        page.url().includes("notification") || page.url().includes("confirm");
      if (hasConfirmationControl || isConfirmationRoute) return page;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `MetaMask confirmation page did not open. Pages: ${context
      .pages()
      .map((page) => page.url())
      .join(", ")}`
  );
}

function settled(promise) {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error })
  );
}

function unwrap(result) {
  if (!result.ok) throw result.error;
  return result.value;
}

async function completeRequest(request, approve, label) {
  const pending = Symbol("pending");
  let lastApprovalError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await Promise.race([
      request,
      new Promise((resolve) => setTimeout(() => resolve(pending), 2_000)),
    ]);
    if (result !== pending) return unwrap(result);
    console.log(`${label}: approval step ${attempt + 1}`);
    const approvalOrRequest = await Promise.race([
      approve().then(
        () => ({ kind: "approval" }),
        (error) => ({ kind: "approvalError", error })
      ),
      request.then((requestResult) => ({ kind: "request", requestResult })),
    ]);
    if (approvalOrRequest.kind === "request") {
      return unwrap(approvalOrRequest.requestResult);
    }
    if (approvalOrRequest.kind === "approvalError") {
      // A fresh MetaMask profile can complete wallet_addEthereumChain without
      // exposing a separate notification page. Give the provider request one
      // final scheduling window before treating the missing UI as a failure.
      const lateResult = await Promise.race([
        request,
        new Promise((resolve) => setTimeout(() => resolve(pending), 2_000)),
      ]);
      if (lateResult !== pending) return unwrap(lateResult);
      lastApprovalError = approvalOrRequest.error;
      continue;
    }
  }
  // A successfully confirmed transaction still needs the broadcast and the
  // provider round-trip to resolve the dapp promise; give it one bounded
  // final window instead of failing while MetaMask is mid-send.
  const finalResult = await Promise.race([
    request,
    new Promise((resolve) => setTimeout(() => resolve(pending), 30_000)),
  ]);
  if (finalResult !== pending) return unwrap(finalResult);
  if (lastApprovalError) throw lastApprovalError;
  throw new Error(`${label} did not settle after three approval steps`);
}

async function approveAddChain(context, extensionId) {
  const page = await waitForConfirmationPage(context, extensionId);
  await page.bringToFront();
  const candidates = [
    page.locator('[data-testid="confirmation-submit-button"]:visible'),
    page.locator('[data-testid="page-container-footer-next"]:visible'),
    page.getByRole("button", { name: /approve|add network|confirm/i }),
    page.locator("button:visible:not([disabled])").last(),
  ];
  for (const candidate of candidates) {
    try {
      if (await candidate.isVisible()) {
        await candidate.click({
          force: true,
          noWaitAfter: true,
          timeout: 5_000,
        });
        return;
      }
    } catch {
      // Try the next stable or generic confirmation selector.
    }
  }
  throw new Error(
    `Could not approve chain request: ${await page.locator("body").innerText()}`
  );
}

async function approveConnection(context, extensionId) {
  const page = await waitForConfirmationPage(context, extensionId);
  await page.bringToFront();
  for (let step = 0; step < 2; step += 1) {
    const button = page.locator("button:visible:not([disabled])").last();
    try {
      await button.click({ force: true, noWaitAfter: true, timeout: 5_000 });
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch {
      if (step === 0) {
        throw new Error(
          `Could not approve connection: ${await page.locator("body").innerText()}`
        );
      }
    }
    if (page.isClosed()) return;
  }
}

// clickFirstVisible tries each candidate locator in order and clicks the
// first one that is actually present, returning whether anything was
// clicked. Playwright's isVisible() is an immediate check, so presence is
// established with waitFor() rather than a timeout option.
async function clickFirstVisible(candidates, timeout = 3_000) {
  for (const candidate of candidates) {
    try {
      const target = candidate.first();
      await target.waitFor({ state: "visible", timeout });
      await target.click({ force: true, timeout: 10_000 });
      return true;
    } catch {
      // Try the next candidate selector.
    }
  }
  return false;
}

// clickEnabled clicks only a button Playwright considers actionable, so a
// disabled confirm button is waited on rather than force-clicked into a
// silent no-op.
async function clickEnabled(candidates, timeout = 8_000) {
  for (const candidate of candidates) {
    try {
      const target = candidate.first();
      await target.waitFor({ state: "visible", timeout: 2_000 });
      if (await target.isDisabled()) continue;
      await target.click({ timeout, noWaitAfter: true });
      return true;
    } catch {
      // Try the next candidate selector.
    }
  }
  return false;
}

// MetaMask 13.39.x can replace the confirm button with a fee-warning review
// modal. Walk that flow — open the alert, acknowledge it, dismiss the modal —
// exactly as a user must on a fresh localnet.
async function acknowledgeFeeWarning(page) {
  const opened = await clickFirstVisible(
    [
      page.locator('[data-testid="inline-alert"]'),
      page.locator('[data-testid="alert-modal-button"]'),
      page.getByRole("button", {
        name: /review alert[s]?|uyarıyı incele|uyarıları incele/iu,
      }),
      page.getByText(/review alert[s]?|uyarıyı incele|uyarıları incele/iu),
    ],
    2_000
  );
  if (!opened) return;

  // The modal releases its action only after an explicit acknowledgement.
  await clickFirstVisible(
    [
      page.locator('[data-testid="alert-modal-acknowledge-checkbox"]'),
      page.locator('input[type="checkbox"]'),
      page.getByText(
        /i have acknowledged|riski anl|uyarıyı okudum|yine de devam/iu
      ),
    ],
    3_000
  );
  await clickFirstVisible(
    [
      page.locator('[data-testid="alert-modal-button"]'),
      page.getByRole("button", {
        name: /got it|confirm|anladım|onayla|yine de/iu,
      }),
    ],
    3_000
  );
  // Give the confirmation surface a moment to re-enable its submit button.
  await page.waitForTimeout(1_500);
}

async function approveTransaction(context, extensionId) {
  const page = await waitForConfirmationPage(context, extensionId);
  await page.bringToFront();

  // Acknowledging a localized fee-warning alert can itself submit the
  // transaction ("Yine de onayla"), after which the surface shows a sending
  // state (or closes) and no enabled footer confirm button ever appears.
  // That is a success, not a failure to confirm.
  const alreadySubmitted = async () => {
    if (page.isClosed()) return true;
    const bodyText = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    return /gönderiliyor|gönderildi|sending|submitted/iu.test(bodyText);
  };

  // The fee-warning modal must be cleared FIRST: MetaMask keeps the footer
  // confirm button mounted but disabled until the alert is acknowledged, and
  // a forced click on a disabled button silently does nothing.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await alreadySubmitted()) return;
    await acknowledgeFeeWarning(page);
    if (await alreadySubmitted()) return;
    const confirmed = await clickEnabled([
      page.locator('[data-testid="confirm-footer-button"]'),
      page.locator('[data-testid="confirmation-submit-button"]'),
      page.getByRole("button", { name: /^(confirm|onayla)$/iu }),
      page.getByRole("button", { name: /confirm|onayla/iu }),
    ]);
    if (confirmed) return;
  }
  if (await alreadySubmitted()) return;
  throw new Error(
    `Could not confirm transaction: ${await page.locator("body").innerText()}`
  );
}

async function rpcCall(method, params) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = await response.json();
  if (payload.error) throw new Error(JSON.stringify(payload.error));
  return payload.result;
}

// The dapp page's provider stream can die after a successful MetaMask
// confirmation (extension renderer instability); the signed transfer is then
// already broadcast even though the dapp promise never settles. Only the
// MetaMask-imported key can produce that transaction, so recovering its hash
// from the canonical chain is equivalent evidence.
async function findSignedTransferOnChain(from, to) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const head = Number(await rpcCall("eth_blockNumber", []));
    for (let number = head; number >= Math.max(0, head - 40); number -= 1) {
      const block = await rpcCall("eth_getBlockByNumber", [
        `0x${number.toString(16)}`,
        true,
      ]);
      const match = (block?.transactions ?? []).find(
        (transaction) =>
          transaction.from?.toLowerCase() === from.toLowerCase() &&
          transaction.to?.toLowerCase() === to.toLowerCase() &&
          transaction.value === "0x1"
      );
      if (match) return match.hash;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return null;
}

async function waitForReceipt(hash) {
  for (let attempt = 0; attempt < 45; attempt += 1) {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getTransactionReceipt",
        params: [hash],
      }),
    });
    const payload = await response.json();
    if (payload.result) return payload.result;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Transaction ${hash} was not mined`);
}

async function addCustomNetworkThroughWalletUi(home, extensionId) {
  await home.goto(`chrome-extension://${extensionId}/home.html#/networks`);
  await home.getByTestId("networks-page-list").waitFor({
    state: "visible",
    timeout: 30_000,
  });
  const networkItem = home.getByTestId(
    `network-list-item-eip155:${expectedChainId}`
  );
  if (await networkItem.isVisible()) return "already-present";

  await home.getByTestId("networks-page-add-custom-network-button").click();
  await home.getByTestId("network-form-network-name").fill(networkName);
  await home.getByTestId("test-add-rpc-drop-down").click();
  await home.getByText(/RPC URL.*(?:add|ekle)/i).click();
  await home.getByTestId("rpc-url-input-test").fill(rpcUrl);
  await home.getByTestId("rpc-name-input-test").fill(rpcDisplayName);
  await home.getByTestId("page-container-footer-next").click();
  await home
    .getByTestId("network-form-chain-id")
    .fill(expectedChainId.toString());
  await home
    .getByTestId("network-form-ticker-input")
    .fill(nativeCurrencySymbol);
  await home.getByTestId("page-container-footer-next").click();
  await networkItem.waitFor({ state: "visible", timeout: 30_000 });
  await home
    .getByTestId("networks-page-network-success-toast")
    .waitFor({ state: "visible", timeout: 30_000 });
  return "wallet-ui";
}

async function main() {
  const server = await startDappServer();
  if (process.env.REUSE_METAMASK_PROFILE !== "1") {
    await rm(profilePath, { recursive: true, force: true });
  }
  let context = await chromium.launchPersistentContext(profilePath, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
    viewport: { width: 1280, height: 900 },
  });

  try {
    let extensionId = await extensionIdFor(context);
    const setupPage = await context.newPage();
    await setupPage.goto(`chrome-extension://${extensionId}/home.html`);
    await onboard(setupPage);
    // A fresh MetaMask onboarding can leave both a completion tab and an
    // automatically opened wallet tab alive. Normalize to one wallet page;
    // otherwise request confirmations can be routed to the stale completion
    // surface and never become actionable through Playwright.
    let home;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      for (const page of context.pages()) {
        if (
          !page.isClosed() &&
          page.url().startsWith(`chrome-extension://${extensionId}/`) &&
          (await walletHomeVisible(page))
        ) {
          home = page;
          break;
        }
      }
      if (home) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!home) {
      throw new Error(
        `MetaMask wallet home did not become visible. Pages: ${context
          .pages()
          .map((page) => page.url())
          .join(", ")}`
      );
    }
    for (const page of context.pages()) {
      if (
        page !== home &&
        !page.isClosed() &&
        page.url().startsWith(`chrome-extension://${extensionId}/`)
      ) {
        await page.close();
      }
    }
    console.log("MetaMask onboarding/unlock complete");
    report.checks.onboarding = { importedDisposableFixture: true };
    const networkConfigurationMethod = await addCustomNetworkThroughWalletUi(
      home,
      extensionId
    );
    report.checks.networkConfiguration = { method: networkConfigurationMethod };
    if (networkConfigurationMethod === "wallet-ui") {
      // MetaMask 13.39.2 persists a newly added network immediately, but its
      // background provider does not service dapp network requests reliably
      // until the extension context is restarted. Reopen the same fresh
      // profile and verify the persisted network through the dapp workflow.
      await context.close();
      context = await chromium.launchPersistentContext(profilePath, {
        headless: false,
        args: [
          `--disable-extensions-except=${extensionPath}`,
          `--load-extension=${extensionPath}`,
        ],
        viewport: { width: 1280, height: 900 },
      });
      extensionId = await extensionIdFor(context);
      home = await context.newPage();
      await home.goto(`chrome-extension://${extensionId}/home.html`);
      await onboard(home);
    }
    await home.goto(`chrome-extension://${extensionId}/home.html`);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await walletHomeVisible(home)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!(await walletHomeVisible(home))) {
      throw new Error("MetaMask wallet home was not ready for the dapp probe");
    }

    const dapp = await context.newPage();
    await dapp.goto(dappUrl);
    await dapp.waitForFunction(() => Boolean(globalThis.ethereum), null, {
      timeout: 30_000,
    });

    const addChain = settled(
      dapp.evaluate(
        async ({
          chainId,
          url,
          networkName,
          nativeCurrencyName,
          nativeCurrencySymbol,
        }) =>
          globalThis.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: `0x${chainId.toString(16)}`,
                chainName: networkName,
                nativeCurrency: {
                  name: nativeCurrencyName,
                  symbol: nativeCurrencySymbol,
                  decimals: 18,
                },
                rpcUrls: [url],
              },
            ],
          }),
        {
          chainId: expectedChainId,
          url: rpcUrl,
          networkName,
          nativeCurrencyName,
          nativeCurrencySymbol,
        }
      )
    );
    await completeRequest(
      addChain,
      () => approveAddChain(context, extensionId),
      "wallet_addEthereumChain"
    );
    const requestAccounts = settled(
      dapp.evaluate(() =>
        globalThis.ethereum.request({ method: "eth_requestAccounts" })
      )
    );
    const accounts = await completeRequest(
      requestAccounts,
      () => approveConnection(context, extensionId),
      "eth_requestAccounts"
    );
    if (accounts[0]?.toLowerCase() !== expectedAccountAddress.toLowerCase()) {
      throw new Error(
        "MetaMask returned an account different from the imported fixture"
      );
    }

    const chainId = await dapp.evaluate(() =>
      globalThis.ethereum.request({ method: "eth_chainId" })
    );
    if (Number(chainId) !== expectedChainId) {
      throw new Error(`MetaMask selected unexpected chain ${chainId}`);
    }

    if (faucetUrl) {
      const fundingResponse = await fetch(faucetUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: accounts[0] }),
      });
      const funding = await fundingResponse.json();
      if (!fundingResponse.ok) {
        throw new Error(
          `Local faucet rejected MetaMask account: ${JSON.stringify(funding)}`
        );
      }
      report.checks.localFaucet = {
        recipient: funding.recipient,
        transactionHash: funding.transactionHash,
        receiptStatus: funding.receiptStatus,
      };
    }

    const send = settled(
      dapp.evaluate(
        async ({ from, to }) => {
          try {
            return await globalThis.ethereum.request({
              method: "eth_sendTransaction",
              // Explicit EIP-1559 fees above the local 1 gwei base-fee floor:
              // wallet-side estimation on a nearly idle localnet can land
              // under the floor, which the node rejects after the wallet has
              // already entered its sending state.
              params: [
                {
                  from,
                  to,
                  value: "0x1",
                  gas: "0x5208",
                  maxFeePerGas: "0xEE6B2800",
                  maxPriorityFeePerGas: "0x3B9ACA00",
                },
              ],
            });
          } catch (error) {
            throw new Error(
              JSON.stringify({
                code: error?.code,
                message: error?.message,
                data: error?.data,
              })
            );
          }
        },
        { from: accounts[0], to: recipient }
      )
    );
    let hash;
    try {
      hash = await completeRequest(
        send,
        () => approveTransaction(context, extensionId),
        "eth_sendTransaction"
      );
    } catch (error) {
      hash = await findSignedTransferOnChain(accounts[0], recipient);
      if (!hash) throw error;
      console.log(
        "eth_sendTransaction promise never settled; recovered the confirmed transfer from the chain"
      );
      report.checks.signedTransferRecovery =
        "provider-promise-hung-hash-recovered-from-canonical-chain";
    }
    const receipt = await waitForReceipt(hash);
    if (receipt.status !== "0x1")
      throw new Error("MetaMask transaction failed");

    report.checks.customNetwork = {
      chainId,
      selected: Number(chainId) === expectedChainId,
    };
    report.checks.account = { address: accounts[0] };
    report.checks.signedTransfer = {
      hash,
      status: receipt.status,
      blockNumber: Number(receipt.blockNumber).toString(),
      valueWei: "1",
    };

    // The receipt can be available before MetaMask's activity cache changes
    // from pending. Give the extension two local block intervals before taking
    // the human-readable proof screenshot.
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    await home.bringToFront();
    await home.reload();
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await walletHomeVisible(home)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    if (screenshotPath) {
      await home.screenshot({ path: screenshotPath, fullPage: true });
    }
    if (reportPath) {
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await context.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
