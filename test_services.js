
const { ethers } = require("ethers");
const { createZGComputeNetworkBroker } = require("@0glabs/0g-serving-broker");

async function main() {
    const RPC = "https://evmrpc-testnet.0g.ai";
    const PRIVATE_KEY = "87cd81039cdd3dc7646252815c0de9eaa212e5c94f135c8dc8066d7b15abe972";
    
    try {
        const provider = new ethers.JsonRpcProvider(RPC);
        const signer = new ethers.Wallet(PRIVATE_KEY, provider);
        const broker = await createZGComputeNetworkBroker(signer);
        
        console.log("Listing services...");
        const services = await broker.inference.listService();
        console.log(`Found ${services.length} services.`);
        
        const chatService = services.find(
            (s) =>
              (s.serviceType ?? "").toLowerCase().includes("chat") ||
              (s.model ?? "").toLowerCase().includes("qwen") ||
              (s.model ?? "").toLowerCase().includes("instruct"),
        );
        
        if (chatService) {
            console.log("Chat service found:", chatService.provider, chatService.model);
        } else {
            console.log("No chat service found.");
        }
    } catch (e) {
        console.error("Error:", e);
    }
}

main();
