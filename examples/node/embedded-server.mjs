// Embed the full TokenSip gateway (proxy + dashboard) in your own Node service.
//   npm install tokensip
import { createTokenSipServer } from "tokensip";

const server = await createTokenSipServer({
  config: {
    port: 8787,
    dataDir: "./.tokensip",
    defaultProfile: "balanced",
  },
});

const url = await server.listen();
console.log(`TokenSip running at ${url}`);
if (server.app.setupToken) console.log(`Finish setup at ${url}/setup?token=${server.app.setupToken}`);

// Programmatic access to the same stores the dashboard uses:
const { key } = server.app.keys.create({ name: "my-service", monthlyBudgetUsd: 25 });
console.log("Virtual key for this service:", key);
