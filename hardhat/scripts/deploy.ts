import { ethers } from "hardhat";
import "dotenv/config";

async function main() {
  const token = process.env.USDT_ADDRESS;
  const receiver1 = process.env.RECEIVER1_ADDRESS;
  const receiver2 = process.env.RECEIVER2_ADDRESS;
  if (!token || !receiver1 || !receiver2) throw new Error("USDT_ADDRESS, RECEIVER1_ADDRESS and RECEIVER2_ADDRESS are required");

  const factory = await ethers.getContractFactory("AllowanceSpender");
  const contract = await factory.deploy(token, receiver1, receiver2);
  await contract.waitForDeployment();
  console.log(`AllowanceSpender deployed to ${await contract.getAddress()}`);
  console.log(`Owner: ${(await ethers.getSigners())[0].address}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });