/* Wraps one firmware main.c (v0.8 or v0.9) so that the simulator can start it
   and look at a few of its static variables.  Compiled WITH instrumentation. */
#define main fw_main
#include FW_MAIN_C
#undef main
#include "sim.h"

void fw_start(void) { (void)fw_main(); }

const FwView *fw_view(void) {
  static const FwView view = {
    &engine_rpm, &crank_synced, &prepared_fuel_us, &prepared_dwell_us,
    &prepared_advance_tenths, &fault_flags, &actuator_test, &last_crank_edge_us,
    (uint8_t *)&cal, sizeof(cal), &cal.fuel_us[0][0], &cal.ignition_tenths[0][0],
    (uint8_t *)&cal.trigger_trim_tenths,
    __builtin_offsetof(Calibration, crc) - __builtin_offsetof(Calibration, trigger_trim_tenths),
    FW_VERSION
  };
  return &view;
}
