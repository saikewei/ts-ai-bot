import { useEffect, useRef } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { Center, Stack, Text, Loader, RingProgress } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconShieldCheck } from "@tabler/icons-react";
import api from "../utils/request";
import axios from "axios";

interface VerifyResponse {
  message: string;
  token: string;
}

export default function AuthHandler() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const ticket = searchParams.get("ticket");
  const hasRequested = useRef(false);

  useEffect(() => {
    if (hasRequested.current) return;
    hasRequested.current = true;

    const verifyIdentity = async () => {
      // 1. 如果 URL 里压根没 token，直接踢到 401
      if (!ticket) {
        navigate("/401", { replace: true });
        return;
      }

      try {
        const response: VerifyResponse = await api.get(
          `/verify-ticket?ticket=${ticket}`,
        );

        // 验证成功：存入本地并跳转主页
        localStorage.setItem("voice_clone_token", response.token);

        notifications.show({
          title: "连接已建立",
          message: "身份验证通过，正在进入系统...",
          color: "teal",
          icon: <IconShieldCheck size={18} />,
          autoClose: 2000,
        });

        // 使用 replace: true 防止用户点击“后退”又回到这个验证页
        navigate("/", { replace: true });
      } catch (error) {
        console.error("Token 校验失败", error);
        if (axios.isAxiosError(error)) {
          if (error.status == 403) {
            navigate("/qr-expired", { replace: true });
          }
        }
      }
    };

    verifyIdentity();
  }, [ticket, navigate]);

  // 展示一个极具科技感的加载界面，提升等待体验
  return (
    <div className="h-screen bg-[#090b14] flex items-center justify-center">
      <Stack align="center" gap="xl">
        <div className="relative">
          {/* 霓虹发光圆环加载器 */}
          <RingProgress
            size={120}
            thickness={4}
            roundCaps
            sections={[{ value: 100, color: "#0FC6C2" }]}
            className="drop-shadow-[0_0_10px_rgba(15,198,194,0.5)]"
            label={
              <Center>
                <Loader color="cyan" type="bars" size="sm" />
              </Center>
            }
          />
        </div>

        <div className="text-center space-y-2">
          <Text
            className="font-mono text-[#0FC6C2] tracking-[0.2em] uppercase animate-pulse"
            size="sm"
          >
            Verifying Identity
          </Text>
          <Text size="xs" className="text-gray-500 font-mono">
            SYNCING NEURAL LINK...
          </Text>
        </div>
      </Stack>
    </div>
  );
}
