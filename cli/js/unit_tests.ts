// Copyright 2018-2020 the Deno authors. All rights reserved. MIT license.

// This test is executed as part of tools/test.py
// But it can also be run manually: ./target/debug/deno cli/js/unit_tests.ts

import "./blob_test.ts";
import "./body_test.ts";
import "./buffer_test.ts";
import "./build_test.ts";
import "./chmod_test.ts";
import "./chown_test.ts";
import "./compiler_api_test.ts";
import "./console_test.ts";
import "./copy_file_test.ts";
import "./custom_event_test.ts";
import "./dir_test.ts";
import "./dispatch_minimal_test.ts";
import "./dispatch_json_test.ts";
import "./error_stack_test.ts";
import "./event_test.ts";
import "./event_target_test.ts";
import "./fetch_test.ts";
import "./file_test.ts";
import "./files_test.ts";
import "./form_data_test.ts";
import "./format_error_test.ts";
import "./fs_events_test.ts";
import "./get_random_values_test.ts";
import "./globals_test.ts";
import "./headers_test.ts";
import "./internals_test.ts";
import "./link_test.ts";
import "./location_test.ts";
import "./make_temp_test.ts";
import "./metrics_test.ts";
import "./mixins/dom_iterable_test.ts";
import "./mkdir_test.ts";
import "./net_test.ts";
import "./os_test.ts";
import "./process_test.ts";
import "./realpath_test.ts";
import "./read_dir_test.ts";
import "./read_file_test.ts";
import "./read_link_test.ts";
import "./remove_test.ts";
import "./rename_test.ts";
import "./request_test.ts";
import "./resources_test.ts";
import "./signal_test.ts";
import "./stat_test.ts";
import "./symbols_test.ts";
import "./symlink_test.ts";
import "./text_encoding_test.ts";
import "./timers_test.ts";
import "./tls_test.ts";
import "./truncate_test.ts";
import "./tty_test.ts";
import "./url_test.ts";
import "./url_search_params_test.ts";
import "./utime_test.ts";
import "./write_file_test.ts";
import "./performance_test.ts";
import "./version_test.ts";
import "./workers_test.ts";

// FIXME(bartlomieju):
// This test file revokes permissions, it must be run last,
// otherwise it might revoke permission for tests that need them.
import "./permissions_test.ts";

if (import.meta.main) {
  await Deno.runTests();
}
