# SIPp 3.7.7 with TLS + PCAP, as the README recommends. Run with --network host
# and the repo mounted at the same path so sipp/scripts relative pcaps resolve.
FROM ubuntu:24.04 AS build
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential cmake git ca-certificates libssl-dev libpcap-dev libnet1-dev \
      libncurses-dev pkg-config libpugixml-dev libgsl-dev \
 && git clone --depth 1 --branch v3.7.7 https://github.com/SIPp/sipp.git /src \
 && cd /src && cmake . -DUSE_SSL=1 -DUSE_PCAP=1 -DUSE_SCTP=0 -DBUILD_TESTING=OFF && make -j"$(nproc)"

FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libssl3t64 libpcap0.8t64 libnet1 libncurses6 libpugixml1v5 libgsl27 ca-certificates \
 && apt-get clean
COPY --from=build /src/sipp /usr/local/bin/sipp
ENTRYPOINT ["sipp"]
