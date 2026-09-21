const dns = require("dns").promises;
const http = require("http");

function getRaw(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 5000 }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

async function diagnose() {
  const host = "naver-chromium.railway.internal";
  const addresses = await dns.lookup(host, { all: true });
  console.log("chromium_dns_ok=" + (addresses.length > 0));
  for (const path of ["/json/version", "/json/list", "/"]) {
    try {
      const r = await getRaw("http://" + host + ":9222" + path);
      console.log("cdp_path=" + path + " status=" + r.status);
      console.log("cdp_content_type=" + (r.headers["content-type"] || ""));
      console.log("cdp_body=" + String(r.body).replace(/[\r\n]+/g, " ").slice(0, 1000));
    } catch (e) {
      console.log("cdp_path=" + path + " error=" + e.message);
    }
  }
}

async function main() {
  console.log("controller_boot=true");
  await diagnose().catch(e => console.log("diagnostic_error=" + e.message));
  console.log("controller_ready=true");
  setInterval(async () => {
    console.log("controller_heartbeat=true");
    await diagnose().catch(e => console.log("diagnostic_error=" + e.message));
  }, 60000);
}
main();
