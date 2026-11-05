import "@nomicfoundation/hardhat-toolbox";
import "dotenv/config";
import { HardhatUserConfig } from "hardhat/config";

const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
const accounts = privateKey ? [privateKey] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.20",
    settings: { optimizer: { enabled: true, runs: 200 } }
  },
  networks: {
    hardhat: {},
    bscTestnet: { url: process.env.BNB_TESTNET_RPC_URL ?? "", chainId: 97, accounts },
    bsc: { url: process.env.BNB_MAINNET_RPC_URL ?? "", chainId: 56, accounts }
  },
  etherscan: { apiKey: process.env.BSCSCAN_API_KEY ?? "" }
};

export default config;