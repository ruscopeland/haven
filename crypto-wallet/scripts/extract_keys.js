import { Wallet } from "ethers";
import * as readline from "readline";

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

console.log("=== Secure Key Extractor ===");
console.log("This script will run locally on your machine and extract your Ethereum/BSC private key.");

rl.question("\nEnter your 12 or 24-word seed phrase: ", (mnemonic) => {
    try {
        // Derive the standard Ethereum/BSC wallet path (m/44'/60'/0'/0/0)
        const wallet = Wallet.fromPhrase(mnemonic.trim());
        
        console.log("\n✅ Wallet Derived Successfully!");
        console.log("--------------------------------------------------");
        console.log("Public Address: ", wallet.address);
        console.log("Private Key:    ", wallet.privateKey);
        console.log("--------------------------------------------------");
        console.log("\n⚠️ IMPORTANT: Keep this private key secret. Never share it with anyone.");
        
    } catch (error) {
        console.error("\n❌ Error: Invalid seed phrase. Please check your spelling and try again.");
    }
    rl.close();
});
