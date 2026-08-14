/**
 * Single-process conformance entry point. Importing the test modules in this
 * exact order registers their tests sequentially so deployed contract
 * addresses flow from earlier files to later ones via ./_state.mjs.
 */
import "./01-network.test.mjs";
import "./02-transactions.test.mjs";
import "./03-contracts.test.mjs";
import "./04-rewards.test.mjs";
import "./05-attestations.test.mjs";
import "./06-subscriptions.test.mjs";
