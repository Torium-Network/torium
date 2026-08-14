// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract ToriumERC20Probe is ERC20 {
    constructor() ERC20("Torium Conformance Token", "TCT") {
        _mint(msg.sender, 1_000_000 ether);
    }

    function alwaysReverts() external pure {
        revert("TORIUM_EXPECTED_REVERT");
    }
}
contract ToriumERC721Probe is ERC721 {
    uint256 private _nextTokenId;

    constructor() ERC721("Torium Conformance NFT", "TCN") {}

    function mint(address recipient) external returns (uint256 tokenId) {
        tokenId = _nextTokenId;
        _nextTokenId += 1;
        _safeMint(recipient, tokenId);
    }
}
