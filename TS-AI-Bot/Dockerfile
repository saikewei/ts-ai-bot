FROM mcr.microsoft.com/dotnet/runtime:8.0 AS base
WORKDIR /app

RUN sed -i 's/deb.debian.org/mirrors.tuna.tsinghua.edu.cn/g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       python3 \
       python3-pip \
       libpython3.11 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# 全局安装 dashscope (使用 --break-system-packages 绕过 Debian 限制)
RUN pip3 install dashscope --break-system-packages -i https://pypi.tuna.tsinghua.edu.cn/simple


FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
ARG BUILD_CONFIGURATION=Release
WORKDIR /src

RUN sed -i 's/deb.debian.org/mirrors.tuna.tsinghua.edu.cn/g' /etc/apt/sources.list.d/debian.sources \
    && apt-get clean \
    && apt-get update \
    && apt-get install -y wget build-essential

RUN wget http://downloads.xiph.org/releases/opus/opus-1.3.1.tar.gz \
    && tar -vxf opus-1.3.1.tar.gz \
    && cd opus-1.3.1 \
    && ./configure \
    && make \
    && make install

COPY ["TS-AI-Bot/TS-AI-Bot.csproj", "TS-AI-Bot/"]
COPY ["TSLib/src/TSLib/TSLib.csproj", "TSLib/src/TSLib/"]
COPY ["NanoWakeWord/NanoWakeWord.csproj", "NanoWakeWord/"]
RUN dotnet restore "TS-AI-Bot/TS-AI-Bot.csproj"
COPY . .
WORKDIR "/src/TS-AI-Bot"
RUN dotnet build "./TS-AI-Bot.csproj" -c $BUILD_CONFIGURATION -o /app/build

FROM build AS publish
ARG BUILD_CONFIGURATION=Release
RUN dotnet publish "./TS-AI-Bot.csproj" -c $BUILD_CONFIGURATION -o /app/publish /p:UseAppHost=false

FROM base AS final
WORKDIR /app

COPY --from=build /usr/local/lib/libopus.so /usr/lib/libopus.so
COPY --from=build /usr/local/lib/libopus.so.0 /usr/lib/libopus.so.0

COPY --from=publish /app/publish .

USER $APP_UID
ENTRYPOINT ["dotnet", "TS-AI-Bot.dll"]
