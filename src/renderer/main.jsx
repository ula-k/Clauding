import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles/theme.css";
import "./styles/app.css";

// Electron 44 quirk: removing a <webview> from the DOM (closing a panel tab,
// switching sessions) raises "Invalid guestInstanceId" from the element's own
// disconnectedCallback, because the guest is already torn down by then. It is
// harmless, so that one message is kept out of the console.
window.addEventListener("error", (event) => {
  if (event.message && event.message.includes("Invalid guestInstanceId")) {
    event.preventDefault();
  }
});

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
