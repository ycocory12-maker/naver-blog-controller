const http = require("http");
const { chromium } = require("playwright-core");

function getVersion() {
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: "naver-chromium.railway.internal",
      port: 9222,
      path: "/json/version",
      headers: { Host: "localhost:9222" },
      timeout: 5000
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error("invalid version json")); }
      });
    });
    req.on("error", reject);
  });
}

async function main() {
  console.log("controller_boot=true");
  try {
    const version = await getVersion();
    const rawWs = version.webSocketDebuggerUrl;
    if (!rawWs) throw new Error("missing websocket debugger url");
    const wsPath = new URL(rawWs).pathname;
    const ws = "ws://naver-chromium.railway.internal:9222" + wsPath;

    const browser = await chromium.connectOverCDP(ws, {
      headers: { Host: "localhost:9222" },
      timeout: 10000
    });
    console.log("playwright_cdp_connected=true");

    const contexts = browser.contexts();
    const pages = contexts.flatMap(c => c.pages());
    console.log("playwright_page_count=" + pages.length);
    for (let i = 0; i < pages.length; i++) {
      console.log("pw_page_" + i + "_title=" + (await pages[i].title()).slice(0, 200));
      console.log("pw_page_" + i + "_url=" + pages[i].url().slice(0, 500));
    }
    const editor = pages.find(p => p.url().includes("blog.naver.com") && p.url().includes("Redirect=Write"));
    console.log("naver_editor_found=" + Boolean(editor));
    if (editor) {
      console.log("naver_editor_title=" + (await editor.title()).slice(0, 200));
    }
    console.log("controller_ready=true");
    setInterval(() => console.log("controller_heartbeat=true"), 60000);
  } catch (e) {
    console.error("controller_error=" + e.message);
    setInterval(() => console.log("controller_heartbeat_after_error=true"), 60000);
  }
}
main();
