// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

// The ERC-4337 v0.7 types this paymaster needs, written from the specification (https://eips.ethereum.org/EIPS/eip-4337)
// rather than imported from eth-infinitism (GPL), so the file stays MIT. Field order and enum values match EntryPoint
// v0.7 at 0x0000000071727De22E5E9d8BAf0edAc6f37da032, so the selectors are the ones that EntryPoint calls.

/// @dev An ERC-4337 v0.7 user operation as the EntryPoint passes it to the paymaster.
struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

/// @dev The EntryPoint v0.7 deposit and stake calls a paymaster makes on its own behalf.
interface IEntryPoint {
    function depositTo(address account) external payable;
    function addStake(uint32 unstakeDelaySec) external payable;
    function unlockStake() external;
    function withdrawStake(address payable withdrawAddress) external;
    function withdrawTo(address payable withdrawAddress, uint256 withdrawAmount) external;
    function balanceOf(address account) external view returns (uint256);
}

/// @dev An ERC-4337 v0.7 paymaster.
interface IPaymaster {
    /// @dev v0.7 calls `postOp` once, with `opSucceeded` or `opReverted`. `postOpReverted` is internal to the
    ///      EntryPoint and never reaches a paymaster.
    enum PostOpMode {
        opSucceeded,
        opReverted,
        postOpReverted
    }

    function validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 maxCost)
        external
        returns (bytes memory context, uint256 validationData);

    function postOp(PostOpMode mode, bytes calldata context, uint256 actualGasCost, uint256 actualUserOpFeePerGas)
        external;
}

/// @title SidequestTestnetPaymaster
/// @notice **Testnet only; the constructor refuses chain 143.** An ERC-4337 v0.7 paymaster that takes gas in one ERC-20
///         (Circle's testnet USDC) at an owner-set rate, because Pimlico has no ERC-20 paymaster tokens on Monad
///         testnet. Mainnet uses Pimlico's paymaster instead. An off-chain signer quotes each operation; the paymaster
///         pays the EntryPoint in MON from its deposit and, in `postOp`, pulls the token cost from the sender to the
///         treasury.
///
///         `paymasterAndData` (v0.7) is `paymaster (20) ‖ pmVerificationGasLimit (16) ‖ pmPostOpGasLimit (16) ‖
///         validUntil (6) ‖ validAfter (6) ‖ signature (65)`: exactly 129 bytes. The signer signs `getHash(...)` as an
///         EIP-191 personal message.
///
///         Validation checks only the quote: the signature and its window. It does not read the sender's token balance
///         or allowance, because both may arrive in the operation's own calls (a batched `approve`, a gas float pulled
///         from an allowance), which run after validation. The token is charged in `postOp`. In v0.7 a reverting
///         `postOp` reverts the operation's own calls too, and the EntryPoint still takes the gas from this paymaster's
///         deposit: an operation that cannot pay costs the paymaster MON and gains its sender nothing. The signer is
///         the guard against that griefing: it simulates each operation and signs only one whose batch approves at
///         least the quoted cost from a sufficient balance. The EntryPoint's 10% penalty on unused execution gas is not
///         passed on to the sender.
///
///         ERC-7562: validation reads this contract's own storage (`exchangeRate`) and returns a context, which
///         bundlers accept only from a staked paymaster (STO-031, EREP-050), so `addStake` before pointing a bundler at
///         it. Everything else validation reads is an immutable.
contract SidequestTestnetPaymaster is IPaymaster, Ownable {
    using SafeERC20 for IERC20;

    uint256 internal constant MAINNET = 143;
    uint256 internal constant SIG_VALIDATION_FAILED = 1;
    uint256 internal constant PAYMASTER_VALIDATION_GAS_OFFSET = 20;
    uint256 internal constant PAYMASTER_POSTOP_GAS_OFFSET = 36;
    uint256 internal constant PAYMASTER_DATA_OFFSET = 52;
    uint256 internal constant SIGNATURE_OFFSET = PAYMASTER_DATA_OFFSET + 12;
    /// @notice The only accepted `paymasterAndData` length: the static fields, the window and a 65-byte signature.
    uint256 public constant PAYMASTER_AND_DATA_LENGTH = SIGNATURE_OFFSET + 65;
    /// @notice `exchangeRate` is quoted per this many wei (1 MON).
    uint256 public constant RATE_UNIT = 1e18;

    IEntryPoint public immutable entryPoint;
    IERC20 public immutable token;
    address public immutable signer;
    address public immutable treasury;

    /// @notice Token base units charged per `RATE_UNIT` wei of gas.
    uint256 public exchangeRate;
    /// @notice Gas charged for `postOp` itself, which `actualGasCost` does not yet include when `postOp` runs. On Monad
    ///         `postOp` measures about 125k cold, 152k for the first charge into an empty treasury.
    uint256 public postOpGas;

    event GasCharged(address indexed sender, uint256 tokenCost, uint256 actualGasCost);
    event ExchangeRateSet(uint256 exchangeRate);
    event PostOpGasSet(uint256 postOpGas);

    error MainnetRefused();
    error ZeroAddress();
    error ZeroExchangeRate();
    error NotEntryPoint(address caller);
    error InvalidPaymasterData(uint256 length);

    constructor(
        IEntryPoint entryPoint_,
        IERC20 token_,
        address signer_,
        address treasury_,
        address owner_,
        uint256 exchangeRate_,
        uint256 postOpGas_
    ) Ownable(owner_) {
        if (block.chainid == MAINNET) revert MainnetRefused();
        if (
            address(entryPoint_) == address(0) || address(token_) == address(0) || signer_ == address(0)
                || treasury_ == address(0)
        ) revert ZeroAddress();
        entryPoint = entryPoint_;
        token = token_;
        signer = signer_;
        treasury = treasury_;
        _setExchangeRate(exchangeRate_);
        _setPostOpGas(postOpGas_);
    }

    modifier onlyEntryPoint() {
        if (msg.sender != address(entryPoint)) revert NotEntryPoint(msg.sender);
        _;
    }

    // ------------------------------------------------------------------ ERC-4337

    /// @notice The quote the signer signs (as an EIP-191 message): every operation field except the signatures, plus
    ///         this chain, this paymaster and the validity window. It is
    ///         `keccak256(abi.encode(address sender, uint256 nonce, bytes32 keccak256(initCode), bytes32 keccak256(callData),
    ///         bytes32 accountGasLimits, uint128 pmVerificationGasLimit, uint128 pmPostOpGasLimit, uint256 preVerificationGas,
    ///         bytes32 gasFees, uint256 chainId, address paymaster, uint48 validUntil, uint48 validAfter))`.
    ///         `paymasterAndData` needs only its 52 static bytes here; the rest is ignored.
    function getHash(PackedUserOperation calldata userOp, uint48 validUntil, uint48 validAfter)
        public
        view
        returns (bytes32)
    {
        bytes calldata pmd = userOp.paymasterAndData;
        if (pmd.length < PAYMASTER_DATA_OFFSET) revert InvalidPaymasterData(pmd.length);
        return keccak256(
            abi.encode(
                userOp.sender,
                userOp.nonce,
                keccak256(userOp.initCode),
                keccak256(userOp.callData),
                userOp.accountGasLimits,
                uint128(bytes16(pmd[PAYMASTER_VALIDATION_GAS_OFFSET:PAYMASTER_POSTOP_GAS_OFFSET])),
                uint128(bytes16(pmd[PAYMASTER_POSTOP_GAS_OFFSET:PAYMASTER_DATA_OFFSET])),
                userOp.preVerificationGas,
                userOp.gasFees,
                block.chainid,
                address(this),
                validUntil,
                validAfter
            )
        );
    }

    /// @notice Checks the signer's quote. A wrong signature does not revert: it returns the ERC-4337 failure bit with
    ///         the window, as the standard asks, and the same context, so a bundler's estimate with a stub signature
    ///         walks the real path, `postOp` included. Malformed `paymasterAndData` reverts. The EntryPoint, not this
    ///         contract, enforces the window.
    /// @return context `abi.encode(sender, exchangeRate)`, so `postOp` charges at the rate the sender was quoted.
    /// @return validationData `sigFailed | validUntil << 160 | validAfter << 208`.
    function validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32, uint256)
        external
        view
        onlyEntryPoint
        returns (bytes memory context, uint256 validationData)
    {
        bytes calldata pmd = userOp.paymasterAndData;
        if (pmd.length != PAYMASTER_AND_DATA_LENGTH) revert InvalidPaymasterData(pmd.length);
        uint48 validUntil = uint48(bytes6(pmd[PAYMASTER_DATA_OFFSET:PAYMASTER_DATA_OFFSET + 6]));
        uint48 validAfter = uint48(bytes6(pmd[PAYMASTER_DATA_OFFSET + 6:SIGNATURE_OFFSET]));
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(getHash(userOp, validUntil, validAfter));
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(digest, pmd[SIGNATURE_OFFSET:]);
        bool sigFailed = err != ECDSA.RecoverError.NoError || recovered != signer;

        context = abi.encode(userOp.sender, exchangeRate);
        validationData =
            (sigFailed ? SIG_VALIDATION_FAILED : 0) | (uint256(validUntil) << 160) | (uint256(validAfter) << 208);
    }

    /// @notice Charges `(actualGasCost + postOpGas * actualUserOpFeePerGas) * rate / RATE_UNIT` tokens, at the rate
    ///         snapshotted in validation, from the sender to the treasury. A reverted operation still pays.
    function postOp(PostOpMode, bytes calldata context, uint256 actualGasCost, uint256 actualUserOpFeePerGas)
        external
        onlyEntryPoint
    {
        (address sender, uint256 rate) = abi.decode(context, (address, uint256));
        uint256 tokenCost = (actualGasCost + postOpGas * actualUserOpFeePerGas) * rate / RATE_UNIT;
        // `sender` is the operation's own account, taken from the context validation returned; only the EntryPoint
        // calls postOp, and the account approved this paymaster for exactly this charge.
        // forge-lint: disable-next-line(arbitrary-send-erc20) -- the from is the paying operation's sender, see above
        if (tokenCost != 0) token.safeTransferFrom(sender, treasury, tokenCost);
        emit GasCharged(sender, tokenCost, actualGasCost);
    }

    // ------------------------------------------------------------------ deposit and stake

    /// @notice Adds MON to this paymaster's EntryPoint deposit. Open to anyone, as `EntryPoint.depositTo` already is.
    function deposit() external payable {
        entryPoint.depositTo{value: msg.value}(address(this));
    }

    /// @notice This paymaster's EntryPoint deposit, which pays for the operations it sponsors.
    function getDeposit() external view returns (uint256) {
        return entryPoint.balanceOf(address(this));
    }

    function addStake(uint32 unstakeDelaySec) external payable onlyOwner {
        entryPoint.addStake{value: msg.value}(unstakeDelaySec);
    }

    function unlockStake() external onlyOwner {
        entryPoint.unlockStake();
    }

    function withdrawStake(address payable to) external onlyOwner {
        entryPoint.withdrawStake(to);
    }

    function withdrawTo(address payable to, uint256 amount) external onlyOwner {
        entryPoint.withdrawTo(to, amount);
    }

    // ------------------------------------------------------------------ pricing

    function setExchangeRate(uint256 exchangeRate_) external onlyOwner {
        _setExchangeRate(exchangeRate_);
    }

    function setPostOpGas(uint256 postOpGas_) external onlyOwner {
        _setPostOpGas(postOpGas_);
    }

    function _setExchangeRate(uint256 exchangeRate_) internal {
        if (exchangeRate_ == 0) revert ZeroExchangeRate();
        exchangeRate = exchangeRate_;
        emit ExchangeRateSet(exchangeRate_);
    }

    function _setPostOpGas(uint256 postOpGas_) internal {
        postOpGas = postOpGas_;
        emit PostOpGasSet(postOpGas_);
    }
}
