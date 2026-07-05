const { ethers } = require("ethers");

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)'
];

async function main() {
  const provider = new ethers.JsonRpcProvider("https://bsc-dataseed.binance.org");
  const tokenAddress = "0x19ed254efa5e061d28d84650891a3db2a9940c16";
  const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);

  try {
    const dec = await contract.decimals();
    console.log("Decimals:", dec);
  } catch (e) {
    console.error("Decimals failed:", e.message);
  }

  try {
    const sym = await contract.symbol();
    console.log("Symbol:", sym);
  } catch (e) {
    console.error("Symbol failed:", e.message);
  }

  try {
    const nm = await contract.name();
    console.log("Name:", nm);
  } catch (e) {
    console.error("Name failed:", e.message);
  }
}

main();
