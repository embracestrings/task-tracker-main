// api/config.js — exposes safe public config to the frontend
// Returns the Microsoft Client ID needed to initiate OAuth from the browser.

export default function handler(req, res) {
  res.status(200).json({
    clientId: process.env.MICROSOFT_CLIENT_ID || "",
  });
}
