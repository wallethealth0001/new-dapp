import { ethers } from "hardhat";

const CONTRACT_ADDRESS = "0x698f4c854C8F6fD8fCC84af2E5d399D78E5792B2";
const EXECUTOR_ADDRESS = "0xd34ff563F947dE63f0C29715865A74BD0c247d1e";

async function main(): Promise<void> {
  const [owner] = await ethers.getSigners();
  const allowanceSpender = await ethers.getContractAt(
    "AllowanceSpender",
    CONTRACT_ADDRESS,
    owner
  );

  const transaction = await allowanceSpender.addExecutor(EXECUTOR_ADDRESS);
  await transaction.wait();

  console.log(`Owner address: ${owner.address}`);
  console.log(`Contract address: ${CONTRACT_ADDRESS}`);
  console.log(`Executor address: ${EXECUTOR_ADDRESS}`);
  console.log(`Transaction hash: ${transaction.hash}`);
  console.log("Executor added successfully!");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
