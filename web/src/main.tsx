import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { MantineProvider, createTheme } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "./index.css";

import App from "./App";
import RobotHome from "./pages/BotHome";
import StatusQrExpired from "./pages/StatusQrExpired";
import StatusUnauthorized from "./pages/StatusUnauthorized";
import AuthHandler from "./pages/AuthHandler";

if (import.meta.env.DEV) {
  import("eruda").then(({ default: eruda }) => {
    eruda.init();
  });
}

const theme = createTheme({
  primaryColor: "blue",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
});

export const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      {
        index: true,
        element: <RobotHome />,
      },
      {
        path: "401",
        element: <StatusUnauthorized />,
      },
      {
        path: "qr-expired",
        element: <StatusQrExpired />,
      },
      {
        path: "login",
        element: <AuthHandler />,
      },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MantineProvider theme={theme}>
      <Notifications position="top-center" zIndex={2000} limit={3} />
      <RouterProvider router={router} />
    </MantineProvider>
  </StrictMode>,
);
