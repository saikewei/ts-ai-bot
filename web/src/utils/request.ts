import axios, {
  AxiosError,
  type InternalAxiosRequestConfig,
  type AxiosResponse,
} from "axios";
import { router } from "../main";
import { notifications } from "@mantine/notifications";

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || "/api",
  timeout: 15000,
});

api.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = localStorage.getItem("voice_clone_token");
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error: AxiosError) => {
    return Promise.reject(error);
  },
);

api.interceptors.response.use(
  (response: AxiosResponse) => {
    return response.data;
  },
  (error: AxiosError) => {
    const status = error.response?.status;
    switch (status) {
      case 401:
        notifications.show({
          title: "未授权",
          message: "登录凭证无效或已过期，请重新授权",
          color: "red",
        });
        localStorage.removeItem("voice_clone_token");
        router.navigate("/401");
        break;
      case 403:
        break;
      default:
        notifications.show({
          title: "请求出错",
          message: error.message || "请检查网络",
          color: "red",
        });
    }
    return Promise.reject(error);
  },
);

export default api;
