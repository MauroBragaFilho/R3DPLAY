/**
 * @file src/r3d_stats.cpp
 * @brief R3D PLAY: telemetria do PC. Windows: PDH (CPU, GPU, temperatura), DXGI (adaptadores), NVML (NVIDIA) e a
 *        API do sistema (RAM e discos). Outras plataformas devolvem só o essencial.
 */
#include "r3d_stats.h"

#include "video.h"

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <chrono>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
  #include <dxgi.h>
  #include <pdh.h>
  #include <pdhmsg.h>
  #include <windows.h>
#endif

using namespace std::literals;

namespace r3d_stats {
#ifdef _WIN32
  namespace {
    // ---- NVML (carregado em tempo de execução; ausente em PCs sem NVIDIA) ----
    struct nvml_util_t {
      unsigned int gpu;
      unsigned int memory;
    };
    struct nvml_mem_t {
      unsigned long long total;
      unsigned long long free;
      unsigned long long used;
    };
    using nvml_handle_t = void *;

    struct nvml_api_t {
      HMODULE lib = nullptr;
      int (*init)() = nullptr;
      int (*count)(unsigned int *) = nullptr;
      int (*handle)(unsigned int, nvml_handle_t *) = nullptr;
      int (*name)(nvml_handle_t, char *, unsigned int) = nullptr;
      int (*temperature)(nvml_handle_t, int, unsigned int *) = nullptr;
      int (*utilization)(nvml_handle_t, nvml_util_t *) = nullptr;
      int (*memory)(nvml_handle_t, nvml_mem_t *) = nullptr;
      bool ok = false;

      nvml_api_t() {
        lib = LoadLibraryW(L"nvml.dll");
        if (!lib) {
          lib = LoadLibraryW(L"C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvml.dll");
        }
        if (!lib) {
          return;
        }
        init = reinterpret_cast<decltype(init)>(GetProcAddress(lib, "nvmlInit_v2"));
        count = reinterpret_cast<decltype(count)>(GetProcAddress(lib, "nvmlDeviceGetCount_v2"));
        handle = reinterpret_cast<decltype(handle)>(GetProcAddress(lib, "nvmlDeviceGetHandleByIndex_v2"));
        name = reinterpret_cast<decltype(name)>(GetProcAddress(lib, "nvmlDeviceGetName"));
        temperature = reinterpret_cast<decltype(temperature)>(GetProcAddress(lib, "nvmlDeviceGetTemperature"));
        utilization = reinterpret_cast<decltype(utilization)>(GetProcAddress(lib, "nvmlDeviceGetUtilizationRates"));
        memory = reinterpret_cast<decltype(memory)>(GetProcAddress(lib, "nvmlDeviceGetMemoryInfo"));
        ok = init && count && handle && name && temperature && utilization && memory && init() == 0;
      }
    };

    struct gpu_info_t {
      std::string name;
      unsigned vendor = 0;
      unsigned long long vram_total = 0;
      std::string luid;  // formato do contador PDH: luid_0x<alto>_0x<baixo>
    };

    struct state_t {
      std::mutex mutex;
      double cpu_usage = -1;
      double cpu_temp_c = -1;
      std::map<std::string, double> gpu_usage;  // por luid
      std::map<std::string, double> gpu_vram_used;  // por luid, bytes
      bool gpu_pdh_ok = false;  // o PDH devolveu instâncias de GPU (adaptadores ociosos podem não aparecer)
      double fps = 0;
      std::vector<gpu_info_t> gpus;
      std::string cpu_name;
      bool started = false;
    };

    state_t &state() {
      static state_t s;
      return s;
    }

    std::string narrow(const wchar_t *w) {
      std::string out;
      for (; *w; ++w) {
        out.push_back(*w < 128 ? static_cast<char>(*w) : '?');
      }
      return out;
    }

    std::string lower(std::string s) {
      for (auto &c : s) {
        c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
      }
      return s;
    }

    std::string wide_to_utf8(const wchar_t *w) {
      int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
      if (n <= 1) {
        return {};
      }
      std::string out(static_cast<size_t>(n - 1), '\0');
      WideCharToMultiByte(CP_UTF8, 0, w, -1, out.data(), n, nullptr, nullptr);
      return out;
    }

    std::vector<gpu_info_t> enumerate_gpus() {
      std::vector<gpu_info_t> out;
      IDXGIFactory1 *factory = nullptr;
      if (FAILED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), reinterpret_cast<void **>(&factory)))) {
        return out;
      }
      IDXGIAdapter1 *adapter = nullptr;
      for (UINT i = 0; factory->EnumAdapters1(i, &adapter) != DXGI_ERROR_NOT_FOUND; ++i) {
        DXGI_ADAPTER_DESC1 d {};
        adapter->GetDesc1(&d);
        adapter->Release();
        std::string name = wide_to_utf8(d.Description);
        auto lname = lower(name);
        bool real_vendor = d.VendorId == 0x8086 || d.VendorId == 0x10DE || d.VendorId == 0x1002;
        bool fake = lname.find("virtual") != std::string::npos || lname.find("spacedesk") != std::string::npos || lname.find("basic render") != std::string::npos;
        if ((d.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) || fake || !real_vendor) {
          continue;
        }
        char luid[64];
        snprintf(luid, sizeof(luid), "luid_0x%08lx_0x%08lx", static_cast<unsigned long>(d.AdapterLuid.HighPart), static_cast<unsigned long>(d.AdapterLuid.LowPart));
        out.push_back({name, d.VendorId, static_cast<unsigned long long>(d.DedicatedVideoMemory), luid});
      }
      factory->Release();
      return out;
    }

    std::string read_cpu_name() {
      char buf[256] = {};
      DWORD size = sizeof(buf);
      if (RegGetValueA(HKEY_LOCAL_MACHINE, "HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0", "ProcessorNameString", RRF_RT_REG_SZ, nullptr, buf, &size) == ERROR_SUCCESS) {
        std::string s(buf);
        auto b = s.find_first_not_of(' ');
        return b == std::string::npos ? s : s.substr(b);
      }
      return "CPU";
    }

    /** Soma/máximo de um contador com curinga (array de instâncias). */
    template<class F>
    void each_instance(PDH_HCOUNTER counter, F &&fn) {
      DWORD bytes = 0, count = 0;
      if (PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &bytes, &count, nullptr) != PDH_MORE_DATA) {
        return;
      }
      std::vector<char> buf(bytes);
      auto *items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W *>(buf.data());
      if (PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &bytes, &count, items) != ERROR_SUCCESS) {
        return;
      }
      for (DWORD i = 0; i < count; ++i) {
        if (items[i].FmtValue.CStatus == PDH_CSTATUS_VALID_DATA || items[i].FmtValue.CStatus == PDH_CSTATUS_NEW_DATA) {
          fn(narrow(items[i].szName), items[i].FmtValue.doubleValue);
        }
      }
    }

    void sampler() {
      PDH_HQUERY query = nullptr;
      if (PdhOpenQueryW(nullptr, 0, &query) != ERROR_SUCCESS) {
        return;
      }
      PDH_HCOUNTER cpu = nullptr, thermal = nullptr, gpu_engine = nullptr, gpu_mem = nullptr;
      if (PdhAddEnglishCounterW(query, L"\\Processor Information(_Total)\\% Processor Utility", 0, &cpu) != ERROR_SUCCESS) {
        PdhAddEnglishCounterW(query, L"\\Processor(_Total)\\% Processor Time", 0, &cpu);
      }
      PdhAddEnglishCounterW(query, L"\\Thermal Zone Information(*)\\Temperature", 0, &thermal);
      PdhAddEnglishCounterW(query, L"\\GPU Engine(*)\\Utilization Percentage", 0, &gpu_engine);
      PdhAddEnglishCounterW(query, L"\\GPU Adapter Memory(*)\\Dedicated Usage", 0, &gpu_mem);
      PdhCollectQueryData(query);

      auto &s = state();
      auto last_frames = video::frames_encoded.load();
      auto last_time = std::chrono::steady_clock::now();

      while (true) {
        std::this_thread::sleep_for(1s);
        PdhCollectQueryData(query);

        double cpu_usage = -1, cpu_temp = -1;
        if (cpu) {
          PDH_FMT_COUNTERVALUE v {};
          if (PdhGetFormattedCounterValue(cpu, PDH_FMT_DOUBLE, nullptr, &v) == ERROR_SUCCESS) {
            cpu_usage = std::min(100.0, v.doubleValue);
          }
        }
        if (thermal) {
          each_instance(thermal, [&](const std::string &, double kelvin) {
            double c = kelvin - 273.15;
            if (c > 0 && c < 150 && c > cpu_temp) {
              cpu_temp = c;
            }
          });
        }
        // GPU: por adaptador (luid), o motor mais ocupado (3D, compute, vídeo...) como no Gerenciador de Tarefas.
        std::map<std::string, std::map<std::string, double>> engines;  // luid -> tipo de motor -> soma
        if (gpu_engine) {
          each_instance(gpu_engine, [&](const std::string &name, double value) {
            auto l = name.find("luid_");
            auto e = name.find("engtype_");
            if (l == std::string::npos || e == std::string::npos) {
              return;
            }
            auto luid_end = name.find("_phys", l);
            auto luid = name.substr(l, luid_end == std::string::npos ? std::string::npos : luid_end - l);
            engines[luid][name.substr(e + 8)] += value;
          });
        }
        std::map<std::string, double> usage;
        for (auto &[luid, by_type] : engines) {
          double best = 0;
          for (auto &[type, sum] : by_type) {
            if (type != "copy") {
              best = std::max(best, sum);
            }
          }
          usage[luid] = std::min(100.0, best);
        }
        std::map<std::string, double> vram;
        if (gpu_mem) {
          each_instance(gpu_mem, [&](const std::string &name, double value) {
            auto l = name.find("luid_");
            if (l == std::string::npos) {
              return;
            }
            auto luid_end = name.find("_phys", l);
            vram[name.substr(l, luid_end == std::string::npos ? std::string::npos : luid_end - l)] += value;
          });
        }

        auto frames = video::frames_encoded.load();
        auto now = std::chrono::steady_clock::now();
        double dt = std::chrono::duration<double>(now - last_time).count();
        double fps = dt > 0 ? static_cast<double>(frames - last_frames) / dt : 0;
        last_frames = frames;
        last_time = now;

        std::lock_guard lock(s.mutex);
        s.cpu_usage = cpu_usage;
        s.cpu_temp_c = cpu_temp;
        s.gpu_pdh_ok = !engines.empty();
        s.gpu_usage = std::move(usage);
        s.gpu_vram_used = std::move(vram);
        s.fps = fps;
      }
    }
  }  // namespace

  nlohmann::json snapshot() {
    auto &s = state();
    static nvml_api_t nvml;
    {
      std::lock_guard lock(s.mutex);
      if (!s.started) {
        s.started = true;
        s.gpus = enumerate_gpus();
        s.cpu_name = read_cpu_name();
        std::thread(sampler).detach();
      }
    }

    nlohmann::json out;
    out["host"] = [] {
      char name[MAX_COMPUTERNAME_LENGTH + 1] = {};
      DWORD size = sizeof(name);
      GetComputerNameA(name, &size);
      return std::string(name);
    }();

    MEMORYSTATUSEX mem {};
    mem.dwLength = sizeof(mem);
    GlobalMemoryStatusEx(&mem);
    SYSTEM_INFO si {};
    GetSystemInfo(&si);

    std::lock_guard lock(s.mutex);
    out["cpu"] = {
      {"name", s.cpu_name},
      {"threads", si.dwNumberOfProcessors},
      {"usage", s.cpu_usage < 0 ? nlohmann::json(nullptr) : nlohmann::json(s.cpu_usage)},
      {"temp_c", s.cpu_temp_c < 0 ? nlohmann::json(nullptr) : nlohmann::json(s.cpu_temp_c)},
    };
    out["ram"] = {{"used", mem.ullTotalPhys - mem.ullAvailPhys}, {"total", mem.ullTotalPhys}};

    auto gpus = nlohmann::json::array();
    bool nvml_used = false;
    for (auto &g : s.gpus) {
      nlohmann::json j = {{"name", g.name}, {"vendor", g.vendor == 0x10DE ? "nvidia" : g.vendor == 0x8086 ? "intel" : "amd"}, {"vram_total", g.vram_total}};
      auto u = s.gpu_usage.find(g.luid);
      j["usage"] = u != s.gpu_usage.end() ? nlohmann::json(u->second) : s.gpu_pdh_ok ? nlohmann::json(0.0) : nlohmann::json(nullptr);
      auto v = s.gpu_vram_used.find(g.luid);
      j["vram_used"] = v == s.gpu_vram_used.end() ? nlohmann::json(nullptr) : nlohmann::json(v->second);
      j["temp_c"] = nullptr;
      if (g.vendor == 0x10DE && nvml.ok && !nvml_used) {
        nvml_used = true;
        unsigned int n = 0;
        nvml_handle_t h = nullptr;
        if (nvml.count(&n) == 0 && n > 0 && nvml.handle(0, &h) == 0) {
          unsigned int temp = 0;
          nvml_util_t util {};
          nvml_mem_t m {};
          if (nvml.temperature(h, 0, &temp) == 0) {
            j["temp_c"] = temp;
          }
          if (nvml.utilization(h, &util) == 0) {
            j["usage"] = util.gpu;
          }
          if (nvml.memory(h, &m) == 0) {
            j["vram_used"] = m.used;
            j["vram_total"] = m.total;
          }
        }
      }
      // Adaptadores virtuais/duplicados repetem o nome da GPU real: fica um por nome (o que tem mais VRAM/uso).
      bool merged = false;
      for (auto &e : gpus) {
        if (e["name"] == j["name"]) {
          merged = true;
          if (e["usage"].is_null() || (!j["usage"].is_null() && j["usage"].get<double>() > e["usage"].get<double>())) {
            e = j;
          }
          break;
        }
      }
      if (!merged) {
        gpus.push_back(std::move(j));
      }
    }
    out["gpus"] = std::move(gpus);

    auto disks = nlohmann::json::array();
    DWORD mask = GetLogicalDrives();
    for (int i = 0; i < 26; ++i) {
      if (!(mask & (1u << i))) {
        continue;
      }
      std::wstring root = std::wstring(1, static_cast<wchar_t>(L'A' + i)) + L":\\";
      if (GetDriveTypeW(root.c_str()) != DRIVE_FIXED) {
        continue;
      }
      ULARGE_INTEGER free_bytes {}, total {}, total_free {};
      if (GetDiskFreeSpaceExW(root.c_str(), &free_bytes, &total, &total_free) && total.QuadPart > 0) {
        disks.push_back({{"name", std::string(1, static_cast<char>('A' + i)) + ":"}, {"used", total.QuadPart - total_free.QuadPart}, {"total", total.QuadPart}});
      }
    }
    out["disks"] = std::move(disks);
    out["stream"] = {{"active", s.fps > 0.5}, {"fps", s.fps}};
    return out;
  }

#else
  nlohmann::json snapshot() {
    return {{"stream", {{"active", false}, {"fps", 0}}}};
  }
#endif
}  // namespace r3d_stats
