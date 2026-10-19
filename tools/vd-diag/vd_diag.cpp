// Diagnóstico da tela virtual (SudoVDA): cria uma tela de teste, mostra o estado dela na configuração de vídeo do
// Windows a cada 500 ms e, com --activate, tenta ativá-la na topologia "estendida". Remove a tela ao terminar.
//   build (MSYS2 UCRT64): g++ -std=gnu++20 -I../../third-party/sudovda vd_diag.cpp -o vd_diag.exe -lsetupapi -lcfgmgr32 -luser32
#include <windows.h>
#include <objbase.h>
#include <cstdint>
#include <cstdio>
#include <dxgi.h>
#include <string>
#include <vector>

#include "sudovda.h"

using namespace SUDOVDA;

static const char *topo_name(UINT32 t) {
  switch (t) {
    case DISPLAYCONFIG_TOPOLOGY_INTERNAL: return "internal";
    case DISPLAYCONFIG_TOPOLOGY_CLONE: return "clone";
    case DISPLAYCONFIG_TOPOLOGY_EXTEND: return "extend";
    case DISPLAYCONFIG_TOPOLOGY_EXTERNAL: return "external";
    default: return "?";
  }
}

static void dump(const VIRTUAL_DISPLAY_ADD_OUT &out) {
  UINT pc = 0, mc = 0;
  std::vector<DISPLAYCONFIG_PATH_INFO> paths;
  std::vector<DISPLAYCONFIG_MODE_INFO> modes;
  LONG rc = ERROR_INSUFFICIENT_BUFFER;
  for (int tries = 0; tries < 5 && rc == ERROR_INSUFFICIENT_BUFFER; tries++) {
    if (GetDisplayConfigBufferSizes(QDC_ALL_PATHS, &pc, &mc) != ERROR_SUCCESS) {
      printf("  GetDisplayConfigBufferSizes falhou\n");
      return;
    }
    paths.assign(pc, {});
    modes.assign(mc, {});
    rc = QueryDisplayConfig(QDC_ALL_PATHS, &pc, paths.data(), &mc, modes.data(), nullptr);
  }
  if (rc != ERROR_SUCCESS) {
    printf("  QueryDisplayConfig falhou (%ld)\n", rc);
    return;
  }
  paths.resize(pc);
  const DISPLAYCONFIG_TOPOLOGY_ID topo = (DISPLAYCONFIG_TOPOLOGY_ID) 0;
  int active_total = 0;
  for (UINT i = 0; i < pc; i++) {
    const auto &p = paths[i];
    bool active = p.flags & DISPLAYCONFIG_PATH_ACTIVE;
    bool mine = p.targetInfo.adapterId.LowPart == out.AdapterLuid.LowPart && p.targetInfo.id == out.TargetId;
    if (active) active_total++;
    // só o que interessa: caminhos ativos e o primeiro caminho da tela de teste (fonte 1)
    if (active || (mine && p.sourceInfo.id == 1)) {
      printf("  %s alvo=%u adaptador=%08lx fonte=%u ativo=%d disponivel=%d\n", mine ? "[TESTE]" : "[ativo]", p.targetInfo.id,
        (unsigned long) p.targetInfo.adapterId.LowPart, p.sourceInfo.id, active ? 1 : 0, p.targetInfo.targetAvailable ? 1 : 0);
    }
  }
  printf("  caminhos ativos no total=%d\n", active_total);
}

int main(int argc, char **argv) {
  bool activate = argc > 1 && std::string(argv[1]) == "--activate";
  HANDLE h = OpenDevice(&SUVDA_INTERFACE_GUID);
  if (h == INVALID_HANDLE_VALUE) {
    printf("Não consegui abrir o driver SudoVDA (erro %lu). Rode como administrador?\n", GetLastError());
    return 1;
  }
  printf("Driver aberto. Protocolo compatível: %d\n", CheckProtocolCompatible(h) ? 1 : 0);

  // --render <trecho do nome da GPU>: escolhe em qual GPU o driver renderiza a tela virtual (ex.: --render Intel, --render NVIDIA)
  for (int i = 1; i + 1 < argc; i++) {
    if (std::string(argv[i]) != "--render") continue;
    std::wstring want(argv[i + 1], argv[i + 1] + strlen(argv[i + 1]));
    IDXGIFactory1 *f = nullptr;
    CreateDXGIFactory1(__uuidof(IDXGIFactory1), (void **) &f);
    IDXGIAdapter1 *ad = nullptr;
    for (UINT k = 0; f && f->EnumAdapters1(k, &ad) != DXGI_ERROR_NOT_FOUND; k++) {
      DXGI_ADAPTER_DESC1 d {};
      ad->GetDesc1(&d);
      ad->Release();
      if (std::wstring(d.Description).find(want) != std::wstring::npos) {
        bool ok = SetRenderAdapter(h, d.AdapterLuid);
        wprintf(L"SetRenderAdapter(%ls) => %d\n", d.Description, ok ? 1 : 0);
        break;
      }
    }
  }

  VIRTUAL_DISPLAY_GET_WATCHDOG_OUT wd {};
  if (GetWatchdogTimeout(h, wd)) printf("Watchdog: timeout=%u contagem=%u\n", wd.Timeout, wd.Countdown);

  GUID guid;
  CoCreateGuid(&guid);
  VIRTUAL_DISPLAY_ADD_OUT out {};
  if (!AddVirtualDisplay(h, 2144, 964, 60, guid, "vd-diag", "diag0001", out)) {
    printf("AddVirtualDisplay FALHOU (erro %lu)\n", GetLastError());
    return 2;
  }
  printf("Tela adicionada: alvo=%u adaptador=%08lx:%08lx\n", out.TargetId, (unsigned long) out.AdapterLuid.HighPart, (unsigned long) out.AdapterLuid.LowPart);

  bool tried = false;
  wchar_t name[CCHDEVICENAME] {};
  for (int i = 0; i < 24; i++) {
    Sleep(500);
    if (wd.Timeout) PingDriver(h);
    printf("t=%.1fs\n", (i + 1) * 0.5);
    dump(out);
    if (GetAddedDisplayName(out, name)) {
      wprintf(L"  >>> nome da tela: %ls\n", name);
      break;
    }
    if (activate && !tried && i >= 3) {
      tried = true;
      LONG r = SetDisplayConfig(0, nullptr, 0, nullptr, SDC_APPLY | SDC_TOPOLOGY_EXTEND | SDC_ALLOW_CHANGES);
      printf("  SetDisplayConfig(EXTEND) => %ld\n", r);
    }
  }
  RemoveVirtualDisplay(h, guid);
  printf("Tela de teste removida.\n");
  CloseHandle(h);
  return 0;
}
