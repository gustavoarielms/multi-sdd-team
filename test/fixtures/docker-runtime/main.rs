use std::fs::{self, OpenOptions};
use std::io;
use std::os::unix::process::CommandExt;
use std::process::{self, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const BINARY: &str = "/usr/local/libexec/sdd-codegraph/runtime-entrypoint";
const ROOT: &str = "/workspace";

unsafe extern "C" {
    fn setsid() -> i32;
    fn getuid() -> u32;
    fn getgid() -> u32;
    fn getppid() -> i32;
}

fn main() {
    if run().is_err() {
        eprintln!("fixture: failed");
        process::exit(2);
    }
}

fn run() -> io::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["--listen", "stdio://"] => probe(),
        ["spawn"] => detached_spawner(),
        ["heartbeat"] => heartbeat(),
        _ => Err(io::Error::other("arguments")),
    }
}

fn detached_spawner() -> io::Result<()> {
    let mut command = Command::new(BINARY);
    command.arg("heartbeat").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    // The heartbeat survives this intermediate parent in its own session.
    unsafe {
        command.pre_exec(|| {
            if setsid() < 0 { return Err(io::Error::last_os_error()); }
            Ok(())
        });
    }
    command.spawn()?;
    Ok(())
}

fn heartbeat() -> io::Result<()> {
    let deadline = Instant::now() + Duration::from_secs(5);
    while unsafe { getppid() } != 1 {
        if Instant::now() >= deadline { return Err(io::Error::other("not reparented")); }
        thread::sleep(Duration::from_millis(10));
    }
    fs::write(format!("{ROOT}/detached-descendant.pid"), format!("{}\n", process::id()))?;
    for counter in 1u64.. {
        let pending = format!("{ROOT}/.heartbeat-next");
        fs::write(&pending, format!("{counter}\n"))?;
        fs::rename(pending, format!("{ROOT}/detached-heartbeat.txt"))?;
        thread::sleep(Duration::from_millis(50));
    }
    Ok(())
}

fn read_only_write(path: &str, create: bool) -> bool {
    OpenOptions::new().write(true).create(create).open(path)
        .is_err_and(|error| error.raw_os_error() == Some(30))
}

struct Mount<'a> {
    id: &'a str,
    parent: &'a str,
    path: &'a str,
    options: &'a str,
}

fn one_mount<'a, 'b>(mounts: &'b [Mount<'a>], path: &str, parent: Option<&str>) -> Option<&'b Mount<'a>> {
    let mut matches = mounts.iter().filter(|mount| mount.path == path && parent.is_none_or(|id| mount.parent == id));
    let found = matches.next()?;
    if matches.next().is_some() { return None; }
    Some(found)
}

fn nested_mount(source: &str) -> (bool, bool) {
    let mounts: Vec<_> = source.lines().filter_map(|line| {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() < 7 { return None; }
        Some(Mount { id: fields[0], parent: fields[1], path: fields[4], options: fields[5] })
    }).collect();
    let Some(workspace) = one_mount(&mounts, ROOT, None) else { return (false, false); };
    let Some(codex) = one_mount(&mounts, "/workspace/.codex", Some(workspace.id)) else { return (false, false); };
    let Some(nested) = one_mount(&mounts, "/workspace/.codex/nested", Some(codex.id)) else { return (false, false); };
    (true, nested.options.split(',').any(|option| option == "ro"))
}

fn probe() -> io::Result<()> {
    let ordinary = fs::write(format!("{ROOT}/ordinary-write.txt"), b"fixture-ordinary-write\n").is_ok();
    let prompt_write = read_only_write("/workspace/.codex/agents/main.toml", false);
    let prompt_create = read_only_write("/workspace/.codex/agents/fixture-write.tmp", true);
    let nested_write = read_only_write("/workspace/.codex/nested/fixture-write.tmp", true);
    let (observed, read_only) = nested_mount(&fs::read_to_string("/proc/self/mountinfo")?);
    let spawner = Command::new(BINARY).arg("spawn").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status()?.success();
    println!("{{\"event\":\"fixture_probe\",\"uid_is_expected\":{},\"gid_is_expected\":{},\"ordinary_write_succeeded\":{},\"prompt_write_read_only\":{},\"prompt_create_read_only\":{},\"nested_mount_observed\":{},\"nested_mount_read_only\":{},\"nested_write_read_only\":{},\"detached_spawner_completed\":{}}}",
        unsafe { getuid() } == 10001, unsafe { getgid() } == 10001, ordinary, prompt_write, prompt_create, observed, read_only, nested_write, spawner);
    loop { thread::park(); }
}

#[cfg(test)]
mod tests {
    use super::nested_mount;

    const ROOTS: &str = "10 1 0:1 / /workspace rw - tmpfs fixture rw\n20 10 0:1 / /workspace/.codex ro - tmpfs fixture rw\n";
    const HIDDEN: &str = "11 10 0:2 / /workspace/.codex/nested rw - tmpfs fixture rw\n";
    const VISIBLE: &str = "21 20 0:2 / /workspace/.codex/nested ro - tmpfs fixture rw\n";

    #[test]
    fn visible_parent_wins_in_both_orders() {
        assert_eq!(nested_mount(&format!("{ROOTS}{HIDDEN}{VISIBLE}")), (true, true));
        assert_eq!(nested_mount(&format!("{VISIBLE}{HIDDEN}{ROOTS}")), (true, true));
    }

    #[test]
    fn writable_missing_and_ambiguous_mounts_fail() {
        assert_eq!(nested_mount(&format!("{ROOTS}{HIDDEN}")), (false, false));
        assert_eq!(nested_mount(&format!("{ROOTS}{}", VISIBLE.replace(" ro ", " rw "))), (true, false));
        assert_eq!(nested_mount(&format!("{ROOTS}{VISIBLE}{VISIBLE}")), (false, false));
        assert_eq!(nested_mount("malformed"), (false, false));
    }
}
