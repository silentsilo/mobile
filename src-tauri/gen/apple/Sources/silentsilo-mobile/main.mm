#include "bindings/bindings.h"

// Backup.swift: iOS wants background task handlers before launch ends.
extern "C" void ss_backup_register(void);

int main(int argc, char * argv[]) {
	ss_backup_register();
	ffi::start_app();
	return 0;
}
