// Local stand-in for an SMS / WhatsApp gateway (test instance only). MedOS's HTTP message provider POSTs { channel, to, text, reference } here;
// every message is kept in memory and can be read back with GET /messages?to=91XXXXXXXXXX.
const http = require("http");
const msgs = [];
http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/send") {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      try { const m = JSON.parse(b); msgs.push({ ...m, at: new Date().toISOString() }); } catch { /* ignore */ }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: `cap-${msgs.length}` }));
    });
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/messages")) {
    const to = new URL(req.url, "http://x").searchParams.get("to");
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify(msgs.filter((m) => !to || m.to === to)));
    return;
  }
  res.writeHead(404); res.end();
}).listen(4299, "127.0.0.1", () => console.log("sms capture on 127.0.0.1:4299"));
