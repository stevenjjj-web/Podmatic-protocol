import { expect } from "chai";
import { ethers } from "hardhat";
import { keccak256, toUtf8Bytes, AbiCoder } from "ethers";

describe("ChainlinkVRFProvider", () => {
  async function setup() {
    const [owner, outsider] = await ethers.getSigners();
    const coordinator = await ethers.deployContract("MockVRFCoordinatorV2Plus");
    const provider = await ethers.deployContract("ChainlinkVRFProvider", [
      await coordinator.getAddress(), ethers.ZeroHash, 1n, 3, 800_000, owner.address,
    ]);
    const consumer = await ethers.deployContract("RevertingConsumer");
    return { owner, outsider, coordinator, provider, consumer };
  }

  it("only lets authorized consumers request and encodes VRF v2.5 extra args", async () => {
    const { outsider, coordinator, provider, consumer } = await setup();
    await expect(provider.connect(outsider).requestRandomness()).to.be.revertedWith("not a consumer");
    await provider.setConsumer(await consumer.getAddress(), true);
    await consumer.request(await provider.getAddress());
    const tag = keccak256(toUtf8Bytes("VRF ExtraArgsV1")).slice(0, 10);
    expect(await coordinator.lastExtraArgs()).to.equal(tag + AbiCoder.defaultAbiCoder().encode(["bool"], [false]).slice(2));
    expect(await coordinator.lastCallbackGasLimit()).to.equal(800_000n);
  });

  it("swallows a reverting consumer callback so the VRF fulfilment succeeds", async () => {
    const { coordinator, provider, consumer } = await setup();
    await provider.setConsumer(await consumer.getAddress(), true);
    await consumer.request(await provider.getAddress());
    await expect(coordinator.deliver(1, 42n)).to.emit(provider, "CallbackFailed");
  });

  it("rejects fulfilments that do not come from the coordinator", async () => {
    const { outsider, provider } = await setup();
    await expect(provider.connect(outsider).rawFulfillRandomWords(1, [1n])).to.be.revertedWith("only coordinator");
  });
});
