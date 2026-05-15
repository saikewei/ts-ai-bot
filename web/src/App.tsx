import { Outlet, useLocation } from "react-router-dom";

export default function App() {
  const location = useLocation();

  const getPageTitle = (path: string) => {
    switch (path) {
      case "/":
        return "克隆嘴替";
      case "/401":
        return "身份校验";
      case "/qr-expired":
        return "授权状态";
      default:
        return "声音克隆系统";
    }
  };

  const hideHeader = location.pathname === "/login";

  return (
    <div className="h-dvh flex flex-col bg-[#f7f8fa]">
      {!hideHeader && (
        <header className="h-14 bg-white border-b flex items-center px-5 shrink-0 shadow-sm z-50">
          <h1 className="text-lg font-bold bg-clip-text text-transparent bg-linear-to-r from-[#165DFF] to-[#0FC6C2]">
            {getPageTitle(location.pathname)}
          </h1>
        </header>
      )}
      <main className="flex-1 overflow-hidden relative">
        <Outlet />
      </main>
    </div>
  );
}
