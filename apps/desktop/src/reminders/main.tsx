import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
import React from "react";
import ReactDOM from "react-dom/client";
import { EventReminders } from "./EventReminders";
import "./reminders.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <EventReminders />
  </React.StrictMode>,
);
