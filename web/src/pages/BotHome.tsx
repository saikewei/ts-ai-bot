import { useState, useCallback, useEffect } from "react";
import {
  Select,
  Textarea,
  Button,
  Card,
  Box,
  LoadingOverlay,
} from "@mantine/core";
import api from "../utils/request";

export default function BotHome() {
  const [selectedVoice, setSelectedVoice] = useState<string | null>(null);
  const [voiceList, setVoiceList] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [text, setText] = useState("");
  const [toast, setToast] = useState<{
    show: boolean;
    type: "success" | "warning" | "error";
    message: string;
  } | null>(null);

  useEffect(() => {
    if (toast?.show) {
      const timer = setTimeout(() => {
        setToast(null);
      }, 3000);

      return () => clearTimeout(timer);
    }
  }, [toast]);

  useEffect(() => {
    const fetchVoices = async () => {
      try {
        setIsLoading(true);
        const data: string[] = await api.get("/voices");
        setVoiceList(data);

        if (data.length > 0) {
          setSelectedVoice(data[0]);
        }
      } catch (error) {
        console.error("Fail to load voices", error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchVoices();
  }, []);

  const handleGenerate = useCallback(async () => {
    if (!text.trim()) {
      setToast({
        show: true,
        type: "warning",
        message: "请输入要合成的文本内容",
      });
      return;
    }
    console.log("Selected Voice:", selectedVoice);
    console.log("Text to Synthesize:", text);

    try {
      await api.get("/say", {
        params: {
          voice: selectedVoice,
          text: text,
        },
      });
      setToast({ show: true, type: "success", message: "语音合成指令已发送" });
    } catch (error) {
      setToast({ show: true, type: "error", message: "语音合成失败，请重试" });
      console.error("Fail to say.", error);
    }
  }, [text, selectedVoice]);

  const handleStop = useCallback(async () => {
    try {
      await api.get("/stop");
      setToast({ show: true, type: "success", message: "已闭嘴" });
    } catch (error) {
      setToast({ show: true, type: "error", message: "语音合成失败，请重试" });
      console.error("Fail to stop.", error);
    }
  }, []);

  return (
    <Box className="h-full overflow-hidden px-6 py-6">
      {/* ======== Toast ======== */}
      {toast?.show && (
        <div
          className={
            "fixed top-16 left-6 right-6 z-50 px-5 py-3 rounded-2xl shadow-lg backdrop-blur-md text-sm font-medium text-center " +
            (toast.type === "warning"
              ? "bg-[rgb(255_247_232/0.95)] text-[#D47500]"
              : toast.type === "error"
                ? "bg-[rgb(255_242_240/0.95)] text-[#CB272D]"
                : "bg-[rgb(232_247_241/0.95)] text-[#00A870]")
          }
          onClick={() => setToast(null)}
        >
          {toast.message}
        </div>
      )}

      {/* ======== 主卡片 ======== */}
      <Card
        shadow="sm"
        padding="lg"
        radius="xl"
        className="shadow-[0_0_20px_rgba(22,93,255,0.08)]!"
      >
        <LoadingOverlay
          visible={isLoading}
          zIndex={1000}
          overlayProps={{ radius: "sm", blur: 2 }}
          loaderProps={{ color: "cyan", type: "bars" }}
        />
        {/* ---- 语音选择 ---- */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="inline-block w-1.5 h-5 rounded-full bg-linear-to-b from-[#165DFF] to-[#0FC6C2]" />
            <span className="text-base font-semibold text-[#1d2129]">
              选择语音
            </span>
          </div>
          <Select
            data={voiceList}
            value={selectedVoice}
            onChange={setSelectedVoice}
            size="lg"
            radius="xl"
            allowDeselect={false}
            className="w-full"
            comboboxProps={{
              transitionProps: { transition: "fade-down", duration: 200 },
            }}
          />
        </div>

        {/* ---- 分隔 ---- */}
        <div className="border-t border-[#f2f3f5] my-5" />

        {/* ---- 文本输入 ---- */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="inline-block w-1.5 h-5 rounded-full bg-linear-to-b from-[#165DFF] to-[#0FC6C2]" />
            <span className="text-base font-semibold text-[#1d2129]">
              输入文本
            </span>
          </div>
          <Textarea
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            placeholder="在此输入要合成语音的文字内容…"
            maxLength={500}
            minRows={4}
            maxRows={8}
            autosize
            radius="xl"
            className="w-full"
            classNames={{ input: "!text-sm" }}
          />
          <div className="text-right text-xs text-[#c9cdd4]">
            {text.length} / 500
          </div>
        </div>

        {/* ---- 分隔 ---- */}
        <div className="border-t border-[#f2f3f5] my-5" />

        {/* ---- 操作按钮 ---- */}
        <div className="flex gap-3">
          <Button
            size="xl"
            onClick={handleGenerate}
            radius="xl"
            className="flex-1 h-12! text-base! font-semibold! active:scale-[0.98]! transition-transform"
            styles={{
              root: {
                background: "linear-gradient(135deg, #165DFF 0%, #0FC6C2 100%)",
                boxShadow: "0 4px 20px rgba(22,93,255,0.35)",
              },
            }}
          >
            播放语音
          </Button>
          <Button
            variant="outline"
            color="red"
            size="xl"
            onClick={handleStop}
            radius="xl"
            className="h-12! text-base! font-semibold! active:scale-[0.98]! transition-transform"
          >
            停止
          </Button>
        </div>
      </Card>

      <div className="h-6" />
    </Box>
  );
}
