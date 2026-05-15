export default function StatusQrExpired() {
  return (
    <div className="h-full flex flex-col items-center justify-center px-6 pb-16">
      {/* 图标 */}
      <div className="relative mb-8">
        <div className="absolute inset-0 rounded-full bg-linear-to-r from-[#FF7D00]/20 to-[#F53F3F]/20 blur-3xl scale-150" />
        <div className="relative w-24 h-24 rounded-full flex items-center justify-center bg-linear-to-br from-[#FF7D00] to-[#F53F3F] shadow-[0_8px_32px_rgba(255,125,0,0.3)]">
          <svg
            viewBox="0 0 48 48"
            fill="none"
            className="w-12 h-12"
            xmlns="http://www.w3.org/2000/svg"
          >
            <rect
              x="8"
              y="8"
              width="32"
              height="32"
              rx="4"
              stroke="white"
              strokeWidth="2.5"
            />
            <rect x="12" y="12" width="6" height="6" rx="1" fill="white" />
            <rect x="30" y="12" width="6" height="6" rx="1" fill="white" />
            <rect x="12" y="30" width="6" height="6" rx="1" fill="white" />
            <rect x="21" y="21" width="6" height="6" rx="1" fill="white" />
            <circle cx="37" cy="37" r="9" fill="white" />
            <circle cx="37" cy="37" r="7.5" fill="#F53F3F" />
            <path
              d="M37 32.5v4.5l2.5 2.5"
              stroke="white"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      </div>

      <h2 className="text-xl font-bold text-[#1d2129] mb-2">授权已过期</h2>
      <p className="text-sm text-[#86909c] text-center leading-relaxed mb-8 max-w-65">
        当前二维码已失效，请重新扫码或联系管理员获取新的授权链接
      </p>
    </div>
  );
}
