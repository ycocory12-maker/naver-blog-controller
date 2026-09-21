const dns = require("dns").promises;
const net = require("net");

function checkPort(host, port, timeout = 5000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok, error) => {
      socket.destroy();
      resolve({ ok, error });
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false, "timeout"));
    socket.once("error", (err) => done(false, err.message));
  });
}

async function main() {
  const host = "naver-chromium.railway.internal";
  console.log("controller_boot=true");
  try {
    const addresses = await dns.lookup(host, { all: true });
    console.log("chromium_dns_ok=" + (addresses.length > 0));

    for (const port of [5900, 5800, 9222]) {
      const result = await checkPort(host, port);
      console.log("port_" + port + "_ok=" + result.ok);
      if (!result.ok) console.log("port_" + port + "_error=" + result.error);
    }

    console.log("controller_ready=true");
    setInterval(() => console.log("controller_heartbeat=true"), 60000);
  } catch (err) {
    console.error("controller_error=" + err.message);
    process.exit(1);
  }
}

main();
