import { expect } from "chai";
import { ethers } from "hardhat";

describe("AllowanceSpender", function () {
  it("only permits an executor and checks allowance and balance", async function () {
    const [owner, executor, wallet, receiver1, receiver2, stranger] = await ethers.getSigners();
    const token = await ethers.deployContract("MockToken", ["Tether", "USDT"]);
    const spender = await ethers.deployContract("AllowanceSpender", [token.target, receiver1.address, receiver2.address]);
    await token.mint(wallet.address, ethers.parseUnits("10", 6));
    await token.connect(wallet).approve(spender.target, ethers.parseUnits("5", 6));
    await expect(spender.connect(stranger).executeToReceiver1(wallet.address, ethers.parseUnits("5", 6))).to.be.revertedWithCustomError(spender, "UnauthorizedExecutor");
    await spender.connect(owner).addExecutor(executor.address);
    await expect(spender.connect(executor).executeToReceiver1(wallet.address, ethers.parseUnits("5", 6))).to.emit(spender, "TransferExecuted");
    expect(await token.balanceOf(receiver1.address)).to.equal(ethers.parseUnits("5", 6));
  });
});