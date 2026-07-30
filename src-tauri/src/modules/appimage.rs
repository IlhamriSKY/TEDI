#[cfg(target_os = "linux")]
pub fn sanitize_env(cmd: &mut std::process::Command) {
    if std::env::var_os("APPIMAGE").is_some() {
        cmd.env_remove("LD_LIBRARY_PATH");
    }
}

#[cfg(not(target_os = "linux"))]
pub fn sanitize_env(_cmd: &mut std::process::Command) {}
