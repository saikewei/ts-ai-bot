export default function StatusUnauthorized() {
  return (
    <div className="h-full flex flex-col items-center justify-center px-6 pb-16">
      {/* 图标 */}
      <div className="relative mb-8">
        <div className="absolute inset-0 rounded-full bg-linear-to-r from-[#165DFF]/20 to-[#0FC6C2]/20 blur-3xl scale-150" />
        <div className="relative w-24 h-24 rounded-full flex items-center justify-center bg-linear-to-br from-[#165DFF] to-[#0FC6C2] shadow-[0_8px_32px_rgba(22,93,255,0.3)]">
          <svg
            viewBox="0 0 48 48"
            fill="none"
            className="w-12 h-12"
            xmlns="http://www.w3.org/2000/svg"
          >
            <rect x="12" y="21" width="24" height="20" rx="3" fill="white" />
            <path
              d="M16 21V16a8 8 0 1 1 16 0v5"
              stroke="white"
              strokeWidth="3.5"
              strokeLinecap="round"
            />
            <circle cx="24" cy="32" r="3" fill="#165DFF" />
            <rect
              x="22.5"
              y="32"
              width="3"
              height="6"
              rx="1.5"
              fill="#165DFF"
            />
          </svg>
        </div>
      </div>

      <h2 className="text-xl font-bold text-[#1d2129] mb-2">身份校验失败</h2>
      <p className="text-sm text-[#86909c] text-center leading-relaxed mb-8 max-w-65">
        暂无访问权限，请重新扫码
      </p>

      <p className="mt-4 text-xs text-[#c9cdd4]">
        如有疑问，请联系管理员获取授权
      </p>
    </div>
  );
}
