const dns = require("dns").promises;
const http = require("http");

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 5000 }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(new Error("invalid_json status=" + res.statusCode)); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

async function main() {
  const host = "naver-chromium.railway.internal";
  console.log("controller_boot=true");
  try {
    const addresses = await dns.lookup(host, { all: true });
    console.log("chromium_dns_ok=" + (addresses.length > 0));

    const version = await getJson("http://" + host + ":9222/json/version");
    console.log("cdp_version_ok=" + (version.status === 200));
    console.log("browser=" + (version.body.Browser || "unknown"));

    const tabs = await getJson("http://" + host + ":9222/json/list");
    const pages = Array.isArray(tabs.body) ? tabs.body.filter(t => t.type === "page") : [];
    console.log("cdp_tabs_ok=true");
    console.log("page_count=" + pages.length);
    pages.forEach((p, i) => {
      const safeUrl = String(p.url || "").replace(/([?&](?:token|key|password|auth)=[^&]+)/gi, "");
      console.log("tab_" + i + "_title=" + String(p.title || "").slice(0, 120));
      console.log("tab_" + i + "_url=" + safeUrl.slice(0, 300));
    });

    console.log("controller_ready=true");
    setInterval(() => console.log("controller_heartbeat=true"), 60000);
  } catch (err) {
    console.error("controller_error=" + err.message);
    process.exit(1);
  }
}

main();
