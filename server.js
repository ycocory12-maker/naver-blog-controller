const dns = require("dns").promises;
const http = require("http");

function getJson(host, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: host, port: 9222, path,
      headers: { Host: "localhost:9222" },
      timeout: 5000
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { reject(new Error("invalid_json status=" + res.statusCode)); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

async function diagnose() {
  const host = "naver-chromium.railway.internal";
  const addresses = await dns.lookup(host, { all: true });
  console.log("chromium_dns_ok=" + (addresses.length > 0));

  const r = await getJson(host, "/json/list");
  console.log("cdp_tabs_status=" + r.status);
  const pages = Array.isArray(r.body) ? r.body.filter(x => x.type === "page") : [];
  console.log("page_count=" + pages.length);
  pages.forEach((p, i) => {
    const title = String(p.title || "").replace(/[\r\n]+/g, " ").slice(0, 200);
    const url = String(p.url || "").replace(/([?&](?:token|key|password|auth)=[^&]+)/gi, "").slice(0, 500);
    console.log("page_" + i + "_title=" + title);
    console.log("page_" + i + "_url=" + url);
  });
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
