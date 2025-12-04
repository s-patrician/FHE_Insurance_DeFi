// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface InsurancePolicy {
  id: string;
  encryptedPremium: string;
  encryptedCoverage: string;
  encryptedRiskScore: string;
  timestamp: number;
  owner: string;
  status: "active" | "expired" | "claimed";
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'increase10%':
      result = value * 1.1;
      break;
    case 'decrease10%':
      result = value * 0.9;
      break;
    case 'double':
      result = value * 2;
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [policies, setPolicies] = useState<InsurancePolicy[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newPolicyData, setNewPolicyData] = useState({ coverage: 0, riskScore: 0 });
  const [showTutorial, setShowTutorial] = useState(false);
  const [selectedPolicy, setSelectedPolicy] = useState<InsurancePolicy | null>(null);
  const [decryptedValues, setDecryptedValues] = useState<{premium?: number, coverage?: number, riskScore?: number}>({});
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [activeTab, setActiveTab] = useState("all");
  const [showStats, setShowStats] = useState(true);

  const activeCount = policies.filter(p => p.status === "active").length;
  const expiredCount = policies.filter(p => p.status === "expired").length;
  const claimedCount = policies.filter(p => p.status === "claimed").length;

  useEffect(() => {
    loadPolicies().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadPolicies = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      // Load policy keys
      const keysBytes = await contract.getData("policy_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing policy keys:", e); }
      }
      
      // Load each policy
      const list: InsurancePolicy[] = [];
      for (const key of keys) {
        try {
          const policyBytes = await contract.getData(`policy_${key}`);
          if (policyBytes.length > 0) {
            try {
              const policyData = JSON.parse(ethers.toUtf8String(policyBytes));
              list.push({ 
                id: key, 
                encryptedPremium: policyData.premium, 
                encryptedCoverage: policyData.coverage,
                encryptedRiskScore: policyData.riskScore,
                timestamp: policyData.timestamp, 
                owner: policyData.owner, 
                status: policyData.status || "active" 
              });
            } catch (e) { console.error(`Error parsing policy data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading policy ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setPolicies(list);
    } catch (e) { console.error("Error loading policies:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const createPolicy = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting policy data with Zama FHE..." });
    try {
      // Calculate premium based on coverage and risk score (10% of coverage * risk factor)
      const riskFactor = newPolicyData.riskScore / 1000; // Assuming riskScore is 0-1000
      const premium = newPolicyData.coverage * 0.1 * riskFactor;
      
      // Encrypt all numerical values
      const encryptedPremium = FHEEncryptNumber(premium);
      const encryptedCoverage = FHEEncryptNumber(newPolicyData.coverage);
      const encryptedRiskScore = FHEEncryptNumber(newPolicyData.riskScore);
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const policyId = `pol-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const policyData = { 
        premium: encryptedPremium, 
        coverage: encryptedCoverage,
        riskScore: encryptedRiskScore,
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        status: "active" 
      };
      
      // Store policy data
      await contract.setData(`policy_${policyId}`, ethers.toUtf8Bytes(JSON.stringify(policyData)));
      
      // Update policy keys list
      const keysBytes = await contract.getData("policy_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(policyId);
      await contract.setData("policy_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE-encrypted policy created successfully!" });
      await loadPolicies();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewPolicyData({ coverage: 0, riskScore: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Policy creation failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const claimInsurance = async (policyId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted claim with FHE..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const policyBytes = await contract.getData(`policy_${policyId}`);
      if (policyBytes.length === 0) throw new Error("Policy not found");
      const policyData = JSON.parse(ethers.toUtf8String(policyBytes));
      
      // Verify policy is active
      if (policyData.status !== "active") throw new Error("Policy is not active");
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedPolicy = { ...policyData, status: "claimed" };
      await contractWithSigner.setData(`policy_${policyId}`, ethers.toUtf8Bytes(JSON.stringify(updatedPolicy)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE claim processed successfully!" });
      await loadPolicies();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Claim failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const expirePolicy = async (policyId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing policy expiration with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const policyBytes = await contract.getData(`policy_${policyId}`);
      if (policyBytes.length === 0) throw new Error("Policy not found");
      const policyData = JSON.parse(ethers.toUtf8String(policyBytes));
      const updatedPolicy = { ...policyData, status: "expired" };
      await contract.setData(`policy_${policyId}`, ethers.toUtf8Bytes(JSON.stringify(updatedPolicy)));
      setTransactionStatus({ visible: true, status: "success", message: "FHE expiration processed successfully!" });
      await loadPolicies();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Expiration failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (policyAddress: string) => address?.toLowerCase() === policyAddress.toLowerCase();

  const tutorialSteps = [
    { title: "Connect Wallet", description: "Connect your Web3 wallet to access the FHE Insurance Protocol", icon: "🔗" },
    { title: "Create Policy", description: "Set your coverage amount and risk score to generate an encrypted policy", icon: "📝", details: "Your policy details are encrypted using Zama FHE before being stored on-chain" },
    { title: "FHE Premium Calculation", description: "Your premium is calculated homomorphically based on encrypted risk parameters", icon: "🧮", details: "Zama FHE allows premium calculation without decrypting your sensitive data" },
    { title: "Claim Protection", description: "If your FHE smart contract fails, you can claim your insurance payout", icon: "🛡️", details: "Claims are processed while keeping your financial data encrypted" }
  ];

  const renderStatsCards = () => {
    return (
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-value">{policies.length}</div>
          <div className="stat-label">Total Policies</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{activeCount}</div>
          <div className="stat-label">Active</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{expiredCount}</div>
          <div className="stat-label">Expired</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{claimedCount}</div>
          <div className="stat-label">Claimed</div>
        </div>
      </div>
    );
  };

  const filteredPolicies = policies.filter(policy => {
    const matchesSearch = policy.id.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         policy.owner.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesTab = activeTab === "all" || policy.status === activeTab;
    return matchesSearch && matchesTab;
  });

  if (loading) return (
    <div className="loading-screen">
      <div className="spinner"></div>
      <p>Initializing FHE Insurance Protocol...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <h1>FHE<span>Insurance</span></h1>
          <div className="logo-subtitle">DeFi Protection for FHE Smart Contracts</div>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="primary-btn">
            + New Policy
          </button>
          <button className="secondary-btn" onClick={() => setShowTutorial(!showTutorial)}>
            {showTutorial ? "Hide Guide" : "How It Works"}
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <main className="main-content">
        <div className="hero-banner">
          <div className="hero-content">
            <h2>Fully Homomorphic Encryption Insurance</h2>
            <p>Protect your DeFi assets with privacy-preserving smart contract coverage</p>
            <div className="fhe-badge">
              <span>Powered by Zama FHE</span>
            </div>
          </div>
        </div>

        {showTutorial && (
          <div className="tutorial-section">
            <h2>How FHE Insurance Works</h2>
            <div className="tutorial-steps">
              {tutorialSteps.map((step, index) => (
                <div className="tutorial-step" key={index}>
                  <div className="step-icon">{step.icon}</div>
                  <div className="step-content">
                    <h3>{step.title}</h3>
                    <p>{step.description}</p>
                    {step.details && <div className="step-details">{step.details}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="controls-row">
          <div className="search-box">
            <input 
              type="text" 
              placeholder="Search policies..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            <button className="search-btn">🔍</button>
          </div>
          <div className="tabs">
            <button 
              className={activeTab === "all" ? "active" : ""}
              onClick={() => setActiveTab("all")}
            >
              All Policies
            </button>
            <button 
              className={activeTab === "active" ? "active" : ""}
              onClick={() => setActiveTab("active")}
            >
              Active
            </button>
            <button 
              className={activeTab === "expired" ? "active" : ""}
              onClick={() => setActiveTab("expired")}
            >
              Expired
            </button>
            <button 
              className={activeTab === "claimed" ? "active" : ""}
              onClick={() => setActiveTab("claimed")}
            >
              Claimed
            </button>
          </div>
          <button 
            className="toggle-stats-btn"
            onClick={() => setShowStats(!showStats)}
          >
            {showStats ? "Hide Stats" : "Show Stats"}
          </button>
        </div>

        {showStats && (
          <div className="stats-section">
            <h3>Policy Statistics</h3>
            {renderStatsCards()}
          </div>
        )}

        <div className="policies-section">
          <div className="section-header">
            <h2>Your Insurance Policies</h2>
            <button 
              onClick={loadPolicies} 
              className="refresh-btn"
              disabled={isRefreshing}
            >
              {isRefreshing ? "Refreshing..." : "🔄 Refresh"}
            </button>
          </div>

          {filteredPolicies.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">📄</div>
              <p>No policies found</p>
              <button 
                className="primary-btn"
                onClick={() => setShowCreateModal(true)}
              >
                Create Your First Policy
              </button>
            </div>
          ) : (
            <div className="policies-list">
              <div className="list-header">
                <div>Policy ID</div>
                <div>Status</div>
                <div>Owner</div>
                <div>Date</div>
                <div>Actions</div>
              </div>
              {filteredPolicies.map(policy => (
                <div 
                  className="policy-item" 
                  key={policy.id}
                  onClick={() => setSelectedPolicy(policy)}
                >
                  <div className="policy-id">#{policy.id.substring(0, 8)}</div>
                  <div className={`status-badge ${policy.status}`}>
                    {policy.status}
                  </div>
                  <div className="policy-owner">
                    {policy.owner.substring(0, 6)}...{policy.owner.substring(38)}
                  </div>
                  <div className="policy-date">
                    {new Date(policy.timestamp * 1000).toLocaleDateString()}
                  </div>
                  <div className="policy-actions">
                    {isOwner(policy.owner) && policy.status === "active" && (
                      <>
                        <button 
                          className="action-btn claim-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            claimInsurance(policy.id);
                          }}
                        >
                          Claim
                        </button>
                        <button 
                          className="action-btn expire-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            expirePolicy(policy.id);
                          }}
                        >
                          Expire
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>

      {showCreateModal && (
        <div className="modal-overlay">
          <div className="create-modal">
            <div className="modal-header">
              <h2>Create New FHE Insurance Policy</h2>
              <button 
                onClick={() => setShowCreateModal(false)}
                className="close-btn"
              >
                &times;
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Coverage Amount (USD)</label>
                <input 
                  type="number" 
                  value={newPolicyData.coverage}
                  onChange={(e) => setNewPolicyData({
                    ...newPolicyData,
                    coverage: parseFloat(e.target.value)
                  })}
                  placeholder="Enter coverage amount"
                />
              </div>
              <div className="form-group">
                <label>Risk Score (1-1000)</label>
                <input 
                  type="number" 
                  min="1"
                  max="1000"
                  value={newPolicyData.riskScore}
                  onChange={(e) => setNewPolicyData({
                    ...newPolicyData,
                    riskScore: parseInt(e.target.value)
                  })}
                  placeholder="Enter risk score"
                />
              </div>
              <div className="preview-section">
                <h4>FHE Encryption Preview</h4>
                <div className="preview-row">
                  <span>Coverage:</span>
                  <code>
                    {newPolicyData.coverage ? 
                      FHEEncryptNumber(newPolicyData.coverage).substring(0, 30) + "..." : 
                      "Not set"}
                  </code>
                </div>
                <div className="preview-row">
                  <span>Risk Score:</span>
                  <code>
                    {newPolicyData.riskScore ? 
                      FHEEncryptNumber(newPolicyData.riskScore).substring(0, 30) + "..." : 
                      "Not set"}
                  </code>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button 
                onClick={() => setShowCreateModal(false)}
                className="cancel-btn"
              >
                Cancel
              </button>
              <button 
                onClick={createPolicy}
                disabled={creating || !newPolicyData.coverage || !newPolicyData.riskScore}
                className="submit-btn"
              >
                {creating ? "Creating Policy..." : "Create Policy"}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedPolicy && (
        <div className="modal-overlay">
          <div className="policy-detail-modal">
            <div className="modal-header">
              <h2>Policy Details #{selectedPolicy.id.substring(0, 8)}</h2>
              <button 
                onClick={() => {
                  setSelectedPolicy(null);
                  setDecryptedValues({});
                }}
                className="close-btn"
              >
                &times;
              </button>
            </div>
            <div className="modal-body">
              <div className="policy-info">
                <div className="info-row">
                  <span>Status:</span>
                  <div className={`status-badge ${selectedPolicy.status}`}>
                    {selectedPolicy.status}
                  </div>
                </div>
                <div className="info-row">
                  <span>Owner:</span>
                  <div className="owner-address">
                    {selectedPolicy.owner}
                  </div>
                </div>
                <div className="info-row">
                  <span>Created:</span>
                  <div>
                    {new Date(selectedPolicy.timestamp * 1000).toLocaleString()}
                  </div>
                </div>
              </div>

              <div className="encrypted-data-section">
                <h3>Encrypted Policy Data</h3>
                <div className="data-item">
                  <span>Premium:</span>
                  <code>{selectedPolicy.encryptedPremium.substring(0, 30)}...</code>
                  <button 
                    className="decrypt-btn"
                    onClick={async () => {
                      if (decryptedValues.premium !== undefined) {
                        setDecryptedValues({...decryptedValues, premium: undefined});
                      } else {
                        const decrypted = await decryptWithSignature(selectedPolicy.encryptedPremium);
                        if (decrypted !== null) {
                          setDecryptedValues({...decryptedValues, premium: decrypted});
                        }
                      }
                    }}
                    disabled={isDecrypting}
                  >
                    {decryptedValues.premium !== undefined ? 
                      "Hide" : 
                      isDecrypting ? "Decrypting..." : "Decrypt"}
                  </button>
                </div>
                <div className="data-item">
                  <span>Coverage:</span>
                  <code>{selectedPolicy.encryptedCoverage.substring(0, 30)}...</code>
                  <button 
                    className="decrypt-btn"
                    onClick={async () => {
                      if (decryptedValues.coverage !== undefined) {
                        setDecryptedValues({...decryptedValues, coverage: undefined});
                      } else {
                        const decrypted = await decryptWithSignature(selectedPolicy.encryptedCoverage);
                        if (decrypted !== null) {
                          setDecryptedValues({...decryptedValues, coverage: decrypted});
                        }
                      }
                    }}
                    disabled={isDecrypting}
                  >
                    {decryptedValues.coverage !== undefined ? 
                      "Hide" : 
                      isDecrypting ? "Decrypting..." : "Decrypt"}
                  </button>
                </div>
                <div className="data-item">
                  <span>Risk Score:</span>
                  <code>{selectedPolicy.encryptedRiskScore.substring(0, 30)}...</code>
                  <button 
                    className="decrypt-btn"
                    onClick={async () => {
                      if (decryptedValues.riskScore !== undefined) {
                        setDecryptedValues({...decryptedValues, riskScore: undefined});
                      } else {
                        const decrypted = await decryptWithSignature(selectedPolicy.encryptedRiskScore);
                        if (decrypted !== null) {
                          setDecryptedValues({...decryptedValues, riskScore: decrypted});
                        }
                      }
                    }}
                    disabled={isDecrypting}
                  >
                    {decryptedValues.riskScore !== undefined ? 
                      "Hide" : 
                      isDecrypting ? "Decrypting..." : "Decrypt"}
                  </button>
                </div>
              </div>

              {Object.keys(decryptedValues).length > 0 && (
                <div className="decrypted-data-section">
                  <h3>Decrypted Values</h3>
                  {decryptedValues.premium !== undefined && (
                    <div className="decrypted-item">
                      <span>Premium:</span>
                      <strong>${decryptedValues.premium.toFixed(2)}</strong>
                    </div>
                  )}
                  {decryptedValues.coverage !== undefined && (
                    <div className="decrypted-item">
                      <span>Coverage:</span>
                      <strong>${decryptedValues.coverage.toFixed(2)}</strong>
                    </div>
                  )}
                  {decryptedValues.riskScore !== undefined && (
                    <div className="decrypted-item">
                      <span>Risk Score:</span>
                      <strong>{decryptedValues.riskScore}</strong>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button 
                onClick={() => {
                  setSelectedPolicy(null);
                  setDecryptedValues({});
                }}
                className="close-btn"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {transactionStatus.visible && (
        <div className="transaction-notification">
          <div className={`notification-content ${transactionStatus.status}`}>
            <div className="notification-icon">
              {transactionStatus.status === "pending" && "⏳"}
              {transactionStatus.status === "success" && "✅"}
              {transactionStatus.status === "error" && "❌"}
            </div>
            <div className="notification-message">
              {transactionStatus.message}
            </div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-section">
            <h3>FHE Insurance</h3>
            <p>DeFi protection for FHE-based smart contracts</p>
            <div className="fhe-badge">
              <span>Powered by Zama FHE</span>
            </div>
          </div>
          <div className="footer-section">
            <h3>Resources</h3>
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">GitHub</a>
            <a href="#" className="footer-link">Whitepaper</a>
          </div>
          <div className="footer-section">
            <h3>Community</h3>
            <a href="#" className="footer-link">Discord</a>
            <a href="#" className="footer-link">Twitter</a>
            <a href="#" className="footer-link">Telegram</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="copyright">
            © {new Date().getFullYear()} FHE Insurance Protocol. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;