const dns = require("dns").promises;

async function main() {
  console.log("controller_boot=true");
  try {
    const addresses = await dns.lookup("naver-chromium.railway.internal", { all: true });
    console.log("chromium_dns_ok=" + (addresses.length > 0));
    console.log("controller_ready=true");
    setInterval(() => console.log("controller_heartbeat=true"), 60000);
  } catch (err) {
    console.error("controller_error=" + err.message);
    process.exit(1);
  }
}

main();
