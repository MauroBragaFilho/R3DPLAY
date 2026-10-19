/**
 * @file src/r3d_stats.h
 * @brief R3D PLAY: telemetria do PC (CPU, RAM, GPU, discos, temperaturas e FPS da transmissão) para o launcher.
 */
#pragma once

#include <nlohmann/json.hpp>

namespace r3d_stats {
  /**
   * @brief Retrato atual do uso do PC. A primeira chamada inicia a coleta em segundo plano (1 Hz); os valores de
   *        CPU/GPU só ficam completos a partir da segunda leitura. Campos indisponíveis vêm como null.
   */
  nlohmann::json snapshot();
}  // namespace r3d_stats
