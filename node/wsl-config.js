const { execFile, exec } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Provisioning operations currently in flight, keyed by distro name. The map
// lives at module level so that a redeploy attaches to the running import
// instead of starting a second one for the same distribution.
const inflightProvisions = {};

// A WSL distribution name has to survive being passed to wsl.exe and being used
// as a folder name, so keep it to characters that need no quoting.
const VALID_DISTRO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

module.exports = function (RED) {
    // "file" and "download" are the pre-0.0.5 names for what is now a single
    // "import" source. Old flows keep working; "download" no longer fetches
    // anything from the internet and needs a local image file instead.
    function normalizeSourceType(sourceType) {
        if (sourceType === "import" || sourceType === "file" || sourceType === "download") {
            return "import";
        }
        return "existing";
    }

    // wsl.exe emits UTF-16LE with a BOM and trailing NULs; normalise to a plain string.
    function decodeWslOutput(buf) {
        if (!buf || buf.length === 0) return "";
        return buf.toString("utf16le").replace(/\uFEFF/g, "").replace(/\0/g, "").trim();
    }

    function parseWslListOutput(stdout) {
        const output = decodeWslOutput(stdout);

        const lines = output.split("\n").map(l => l.trim()).filter(l => l.length > 0);
        const distros = [];

        for (let i = 1; i < lines.length; i++) {
            let line = lines[i].replace(/^\*\s*/, "");
            const parts = line.split(/\s+/);
            if (parts.length >= 3) {
                distros.push({
                    name: parts[0],
                    state: parts[1],
                    version: parts[2]
                });
            }
        }

        return distros;
    }

    function listDistros(callback) {
        execFile("wsl.exe", ["-l", "-v"], { encoding: "buffer", windowsHide: true, timeout: 10000 }, (error, stdout) => {
            if (error) return callback(error, []);
            callback(null, parseWslListOutput(stdout));
        });
    }

    // Start a provisioning operation for a distro. `subscriber` receives
    // (phase, detail) updates; more subscribers can be added to the returned
    // operation while it is in flight.
    function startProvision(distro, subscriber, runner) {
        const op = { phase: "starting", detail: "", subscribers: [subscriber] };
        inflightProvisions[distro] = op;
        runner(function report(phase, detail) {
            op.phase = phase;
            op.detail = detail || "";
            if (phase === "ready" || phase === "error") {
                delete inflightProvisions[distro];
            }
            op.subscribers.slice().forEach((fn) => {
                try { fn(phase, op.detail); } catch (e) {}
            });
        });
        return op;
    }

    function WslConfigNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.distro = (config.distro || "").trim();
        node.sourceType = normalizeSourceType(config.sourceType);
        node.sourceFile = config.sourceFile;
        node.installLocation = config.installLocation;
        // Removing the config node only unregisters the distribution when the
        // user has explicitly asked for it. Defaulting this to false means that
        // re-importing a flow, or reinstalling this module, never destroys an
        // environment that still holds the user's work.
        node.removeOnDelete = config.removeOnDelete === true;
        node.provisionStatus = "checking";
        node.provisionDetail = "";

        // Flows saved before automatic downloads were removed have no image
        // file to import from, so they need a message that says what to do.
        const wasDownloadSource = config.sourceType === "download";

        function handleProvisionEvent(phase, detail) {
            node.provisionStatus = phase;
            node.provisionDetail = detail || "";
            if (phase === "error") {
                node.error('WSL provisioning of "' + node.distro + '" failed: ' + node.provisionDetail);
            }
            node.emit("wsl-provision", { status: phase, detail: node.provisionDetail });
        }

        function resolveInstallLocation() {
            return node.installLocation || path.join(os.homedir(), "wsl", node.distro);
        }

        // Marker written next to an imported distribution, so that "On delete"
        // can tell an environment this node created from one that was merely
        // adopted. It has to live on disk rather than in memory: after a
        // Node-RED restart an imported distribution looks exactly like a
        // pre-existing one.
        function importMarkerPath() {
            return path.join(resolveInstallLocation(), ".node-red-wsl-import");
        }

        function wasImportedByThisNode() {
            try {
                return fs.readFileSync(importMarkerPath(), "utf8").trim() === node.distro;
            } catch (e) {
                return false;
            }
        }

        function importImage(file, installLocation, report) {
            try {
                fs.mkdirSync(installLocation, { recursive: true });
            } catch (e) {
                return report("error", "Failed to create install location: " + e.message);
            }
            report("importing");
            execFile("wsl.exe", ["--import", node.distro, installLocation, file], { encoding: "buffer", windowsHide: true, timeout: 0 }, (error, stdout) => {
                if (error) {
                    return report("error", decodeWslOutput(stdout) || error.message);
                }
                try {
                    fs.writeFileSync(importMarkerPath(), node.distro);
                } catch (e) {
                    // Only "On delete" depends on the marker; a distribution
                    // that cannot be marked is simply never auto-removed.
                    node.warn("Could not record import marker: " + e.message);
                }
                node.log('Imported WSL distribution "' + node.distro + '" from ' + file);
                report("ready");
            });
        }

        function provision(report) {
            if (!node.sourceFile) {
                if (wasDownloadSource) {
                    return report("error", "Automatic image download has been removed. Set the image file to a "
                        + ".tar/.tar.gz image already stored on this PC.");
                }
                return report("error", "Image file is not set");
            }
            if (!fs.existsSync(node.sourceFile)) {
                return report("error", "Image file does not exist: " + node.sourceFile);
            }
            let stat;
            try {
                stat = fs.statSync(node.sourceFile);
            } catch (e) {
                return report("error", "Cannot read image file: " + e.message);
            }
            if (!stat.isFile()) {
                return report("error", "Image path is not a file: " + node.sourceFile);
            }

            importImage(node.sourceFile, resolveInstallLocation(), report);
        }

        if (!node.distro) {
            handleProvisionEvent("error", "Distro name is not set");
        } else if (node.sourceType === "import" && !VALID_DISTRO_NAME.test(node.distro)) {
            handleProvisionEvent("error", 'Invalid distribution name "' + node.distro
                + '". Use letters, digits, dot, dash and underscore only.');
        } else if (inflightProvisions[node.distro]) {
            const op = inflightProvisions[node.distro];
            op.subscribers.push(handleProvisionEvent);
            handleProvisionEvent(op.phase, op.detail);
        } else {
            listDistros((err, distros) => {
                if (err) {
                    // Without a reliable list an import could clash with a
                    // distribution that is already registered, so only warn.
                    node.warn("Could not verify WSL distributions: " + err.message);
                    return handleProvisionEvent("ready");
                }

                if (distros.some((d) => d.name === node.distro)) {
                    // The environment is already on this PC: adopt it as it is.
                    // This is what makes an existing environment usable again
                    // after the module or the flow has been reinstalled.
                    if (node.sourceType === "import") {
                        node.log('WSL distribution "' + node.distro + '" already exists; using it without importing');
                    }
                    return handleProvisionEvent("ready");
                }

                if (node.sourceType === "import") {
                    node.log('Importing WSL distribution "' + node.distro + '"');
                    startProvision(node.distro, handleProvisionEvent, provision);
                } else {
                    handleProvisionEvent("error", 'Distribution "' + node.distro + '" is not installed');
                }
            });
        }

        node.on("close", function (removed, done) {
            const op = inflightProvisions[node.distro];
            if (op) {
                const idx = op.subscribers.indexOf(handleProvisionEvent);
                if (idx >= 0) op.subscribers.splice(idx, 1);
            }

            // Only unregister when the user opted in explicitly *and* this node
            // is the one that imported the distribution. Distributions that were
            // merely referenced or adopted are left alone, so that deleting or
            // re-importing a flow cannot destroy an environment that was already
            // on this PC.
            if (removed && node.distro && node.sourceType === "import"
                && node.removeOnDelete && wasImportedByThisNode()) {
                execFile("wsl.exe", ["--unregister", node.distro], { encoding: "buffer", windowsHide: true, timeout: 60000 }, (error, stdout) => {
                    if (error) {
                        RED.log.warn('wsl-config: failed to unregister "' + node.distro + '": ' + (decodeWslOutput(stdout) || error.message));
                    } else {
                        RED.log.info('wsl-config: unregistered WSL distribution "' + node.distro + '"');
                    }
                    done();
                });
            } else {
                done();
            }
        });
    }

    RED.nodes.registerType("wsl-config", WslConfigNode);

    RED.httpAdmin.get("/wsl-config/distros", function (req, res) {
        listDistros((error, distros) => {
            if (error) {
                return res.json([]);
            }
            res.json(distros);
        });
    });

    // Checks that an image file typed into the editor actually exists, so that
    // a wrong path is reported while editing rather than at deploy time.
    RED.httpAdmin.get("/wsl-config/check-image", function (req, res) {
        const filePath = req.query.path;
        if (!filePath) {
            return res.status(400).json({ error: "Image file path is required" });
        }
        fs.stat(filePath, (error, stat) => {
            if (error) {
                return res.json({ exists: false, error: error.code === "ENOENT" ? "File not found" : error.message });
            }
            if (!stat.isFile()) {
                return res.json({ exists: false, error: "Path is not a file" });
            }
            res.json({ exists: true, size: stat.size });
        });
    });

    RED.httpAdmin.get("/wsl-config/distro-path/:name", function (req, res) {
        const distroName = req.params.name;
        exec('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss" /s', { windowsHide: true, timeout: 5000 }, (error, stdout) => {
            if (error) {
                return res.json({ path: "" });
            }

            const blocks = stdout.split(/\r?\n\r?\n/);
            for (const block of blocks) {
                if (block.includes("DistributionName") && block.includes(distroName)) {
                    const nameMatch = block.match(/DistributionName\s+REG_SZ\s+(.+)/);
                    if (nameMatch && nameMatch[1].trim() === distroName) {
                        const pathMatch = block.match(/BasePath\s+REG_SZ\s+(.+)/);
                        if (pathMatch) {
                            return res.json({ path: pathMatch[1].trim() });
                        }
                    }
                }
            }

            res.json({ path: "" });
        });
    });

    // Export a distribution to a .tar file: wsl --export <distro> <file>
    RED.httpAdmin.post("/wsl-config/export", function (req, res) {
        const distroName = req.body.distro;
        const filePath = req.body.file;
        if (!distroName) {
            return res.status(400).json({ error: "Distro name is required" });
        }
        if (!filePath) {
            return res.status(400).json({ error: "Export file path is required" });
        }
        if (!/^[A-Za-z]:\\/.test(filePath)) {
            return res.status(400).json({ error: "Export file path must be an absolute Windows path (e.g. C:\\backup\\ubuntu.tar)" });
        }

        // Export of a large distro can take minutes; do not time out.
        execFile("wsl.exe", ["--export", distroName, filePath], { encoding: "buffer", windowsHide: true, timeout: 0 }, (error, stdout) => {
            if (error) {
                const message = decodeWslOutput(stdout) || error.message;
                return res.status(500).json({ error: message });
            }
            res.json({ message: decodeWslOutput(stdout) || "Exported successfully" });
        });
    });

    RED.httpAdmin.post("/wsl-config/unregister", function (req, res) {
        const distroName = req.body.distro;
        if (!distroName) {
            return res.status(400).json({ error: "Distro name is required" });
        }

        execFile("wsl.exe", ["--unregister", distroName], { encoding: "buffer", windowsHide: true, timeout: 30000 }, (error, stdout) => {
            if (error) {
                const message = decodeWslOutput(stdout) || error.message;
                return res.status(500).json({ error: message });
            }
            res.json({ message: decodeWslOutput(stdout) || "Unregistered successfully" });
        });
    });

    RED.httpAdmin.post("/wsl-config/delete-folder", function (req, res) {
        const folderPath = req.body.path;
        if (!folderPath) {
            return res.status(400).json({ error: "Folder path is required" });
        }

        // Validate the path looks like an absolute Windows path
        // and does not contain characters that could break the command
        if (!/^[A-Za-z]:\\/.test(folderPath) || /["<>|&%^]/.test(folderPath)) {
            return res.status(400).json({ error: "Invalid folder path" });
        }

        // A drive root or a single top-level folder is never a WSL install
        // location, and deleting one would take unrelated data with it.
        const segments = folderPath.replace(/[\\/]+$/, "").split(/[\\/]+/).slice(1).filter(s => s.length > 0);
        if (segments.length < 2) {
            return res.status(400).json({ error: "Refusing to delete a drive root or a top-level folder: " + folderPath });
        }

        let stat;
        try {
            stat = fs.statSync(folderPath);
        } catch (e) {
            return res.status(400).json({ error: "Folder does not exist: " + folderPath });
        }
        if (!stat.isDirectory()) {
            return res.status(400).json({ error: "Path is not a folder: " + folderPath });
        }

        const rmCmd = `rmdir /s /q "${folderPath}"`;
        exec(rmCmd, { windowsHide: true, timeout: 30000 }, (error, stdout, stderr) => {
            if (error) {
                return res.status(500).json({ error: stderr || error.message });
            }
            res.json({ message: "Folder deleted successfully" });
        });
    });
};
