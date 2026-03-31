FROM mcr.microsoft.com/dotnet/runtime:8.0 AS base
WORKDIR /app

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
