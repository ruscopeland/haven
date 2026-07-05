const { ethers } = require("ethers");
console.log("lowercase:", ethers.isAddress("0x19ed254efa5e061d28d84650891a3db2a9940c16"));
console.log("uppercase:", ethers.isAddress("0x19ED254EFA5E061D28D84650891A3DB2A9940C16"));
console.log("checksummed:", ethers.isAddress("0x19ed254Efa5E061d28d84650891a3db2a9940C16")); // random mix
