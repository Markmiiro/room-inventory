import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { App } from "./App";
import { UpdateBar } from "./components/UpdateBar";
import "./styles/index.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
      <UpdateBar />
    </BrowserRouter>
  </React.StrictMode>,
);
