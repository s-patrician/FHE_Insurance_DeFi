pragma solidity ^0.8.24;
import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract FHEInsuranceDeFiFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    struct Batch {
        uint256 id;
        bool isOpen;
        uint256 totalEncryptedPremiums; // euint32 ciphertext
        uint256 totalEncryptedPayouts;  // euint32 ciphertext
        uint256 encryptedRiskScore;      // euint32 ciphertext
    }
    uint256 public currentBatchId;
    mapping(uint256 => Batch) public batches;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event PauseToggled(bool paused);
    event CooldownSecondsChanged(uint256 oldCooldown, uint256 newCooldown);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event DataSubmitted(address indexed provider, uint256 indexed batchId, uint256 encryptedPremium, uint256 encryptedPayout);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 totalPremiums, uint256 totalPayouts, uint256 riskScore);

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosedOrNonexistent();
    error ReplayDetected();
    error StateMismatch();
    error InvalidBatchId();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkSubmissionCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        cooldownSeconds = 60; // Default cooldown
        emit ProviderAdded(owner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PauseToggled(_paused);
    }

    function setCooldownSeconds(uint256 newCooldown) external onlyOwner {
        require(newCooldown > 0, "Cooldown must be positive");
        emit CooldownSecondsChanged(cooldownSeconds, newCooldown);
        cooldownSeconds = newCooldown;
    }

    function openBatch() external onlyOwner whenNotPaused {
        currentBatchId++;
        batches[currentBatchId] = Batch({
            id: currentBatchId,
            isOpen: true,
            totalEncryptedPremiums: 0, // Placeholder, will be FHE.asEuint32(0) ciphertext
            totalEncryptedPayouts: 0,  // Placeholder
            encryptedRiskScore: 0      // Placeholder
        });
        // Initialize FHE accumulators for the new batch
        euint32 memory zero = FHE.asEuint32(0);
        batches[currentBatchId].totalEncryptedPremiums = FHE.toBytes32(zero);
        batches[currentBatchId].totalEncryptedPayouts = FHE.toBytes32(zero);
        batches[currentBatchId].encryptedRiskScore = FHE.toBytes32(zero);

        emit BatchOpened(currentBatchId);
    }

    function closeBatch(uint256 batchId) external onlyOwner whenNotPaused {
        if (batchId == 0 || batchId > currentBatchId || !batches[batchId].isOpen) {
            revert InvalidBatchId();
        }
        batches[batchId].isOpen = false;
        emit BatchClosed(batchId);
    }

    function submitData(
        uint256 batchId,
        uint256 encryptedPremium, // bytes32 representation of euint32
        uint256 encryptedPayout   // bytes32 representation of euint32
    ) external onlyProvider whenNotPaused checkSubmissionCooldown {
        if (batchId == 0 || batchId > currentBatchId || !batches[batchId].isOpen) {
            revert BatchClosedOrNonexistent();
        }

        lastSubmissionTime[msg.sender] = block.timestamp;

        euint32 memory premium_ct = FHE.asEuint32(encryptedPremium);
        euint32 memory payout_ct = FHE.asEuint32(encryptedPayout);

        // Load current batch accumulators
        euint32 memory currentTotalPremiums = FHE.asEuint32(batches[batchId].totalEncryptedPremiums);
        euint32 memory currentTotalPayouts = FHE.asEuint32(batches[batchId].totalEncryptedPayouts);

        // Homomorphically add new values
        euint32 memory newTotalPremiums = FHE.add(currentTotalPremiums, premium_ct);
        euint32 memory newTotalPayouts = FHE.add(currentTotalPayouts, payout_ct);

        // Store updated accumulators
        batches[batchId].totalEncryptedPremiums = FHE.toBytes32(newTotalPremiums);
        batches[batchId].totalEncryptedPayouts = FHE.toBytes32(newTotalPayouts);

        // For simplicity, risk score calculation is not implemented here but would use FHE operations
        // e.g., riskScore = FHE.mul(someFactor, FHE.sub(newTotalPayouts, newTotalPremiums));
        // For this example, we'll just pass one of the accumulators as a placeholder for risk score.
        batches[batchId].encryptedRiskScore = FHE.toBytes32(newTotalPayouts); // Placeholder

        emit DataSubmitted(msg.sender, batchId, encryptedPremium, encryptedPayout);
    }

    function requestBatchDecryption(uint256 batchId) external onlyProvider whenNotPaused checkDecryptionCooldown {
        if (batchId == 0 || batchId > currentBatchId || batches[batchId].isOpen) {
            revert BatchClosedOrNonexistent();
        }

        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        bytes32[] memory cts = new bytes32[](3);
        cts[0] = batches[batchId].totalEncryptedPremiums;
        cts[1] = batches[batchId].totalEncryptedPayouts;
        cts[2] = batches[batchId].encryptedRiskScore;

        bytes32 stateHash = _hashCiphertexts(cts);

        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);
        decryptionContexts[requestId] = DecryptionContext({
            batchId: batchId,
            stateHash: stateHash,
            processed: false
        });

        emit DecryptionRequested(requestId, batchId, stateHash);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts, // abi.encode(uint256, uint256, uint256)
        bytes memory proof
    ) public {
        DecryptionContext storage ctx = decryptionContexts[requestId];

        if (ctx.processed) revert ReplayDetected();
        // Security: Replay protection ensures this callback is processed only once.

        bytes32[] memory currentCts = new bytes32[](3);
        currentCts[0] = batches[ctx.batchId].totalEncryptedPremiums;
        currentCts[1] = batches[ctx.batchId].totalEncryptedPayouts;
        currentCts[2] = batches[ctx.batchId].encryptedRiskScore;

        bytes32 currentHash = _hashCiphertexts(currentCts);
        if (currentHash != ctx.stateHash) revert StateMismatch();
        // Security: State hash verification ensures that the ciphertexts being decrypted
        // are the same ones that were committed to when the decryption was requested,
        // preventing certain front-running or manipulation attacks.

        FHE.checkSignatures(requestId, cleartexts, proof);

        (uint256 totalPremiums, uint256 totalPayouts, uint256 riskScore) = abi.decode(cleartexts, (uint256, uint256, uint256));

        ctx.processed = true;
        emit DecryptionCompleted(requestId, ctx.batchId, totalPremiums, totalPayouts, riskScore);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    // FHE.init() is called automatically by FHE.asEuint32 and other FHE operations if not already initialized.
    // No explicit _initIfNeeded or _requireInitialized needed with current FHE.sol patterns.
}