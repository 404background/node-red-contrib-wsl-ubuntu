const { execFile, exec } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");

// Catalog of clean Ubuntu rootfs images that can be imported into WSL.
// Only WSL-targeted images are listed; Ubuntu 20.04 is intentionally absent
// because Canonical does not publish a WSL rootfs for it.
const UBUNTU_WSL_IMAGES = {
    "24.04": {
        label: "Ubuntu 24.04 LTS (Noble Numbat)",
        amd64: "https://cloud-images.ubuntu.com/wsl/releases/24.04/current/ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz",
        arm64: "https://cloud-images.ubuntu.com/wsl/releases/24.04/current/ubuntu-noble-wsl-arm64-wsl.rootfs.tar.gz"
    },
    "22.04": {
        label: "Ubuntu 22.04 LTS (Jammy Jellyfish)",
        amd64: "https://cloud-images.ubuntu.com/wsl/releases/22.04/current/ubuntu-jammy-wsl-amd64-wsl.rootfs.tar.gz",
        arm64: "https://cloud-images.ubuntu.com/wsl/releases/22.04/current/ubuntu-jammy-wsl-arm64-wsl.rootfs.tar.gz"
    }
};

function hostArch() {
    return os.arch() === "arm64" ? "arm64" : "amd64";
}

// Provisioning operations currently in flight, keyed by distro name. The map
// lives at module level so that a redeploy attaches to the running
// download/import instead of starting a second one for the same distribution.
const inflightProvisions = {};

module.exports = function (RED) {
    // wsl.exe emits UTF-16LE with a BOM and trailing NULs; normalise to a plain string.
    function decodeWslOutput(buf) {
        if (!buf || buf.length === 0) return "";
        return buf.toString("utf16le").replace(/﻿/g, "").replace(/\0/g, "").trim();
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

    // Download a URL to destPath, following redirects. Calls cb(err).
    function downloadFile(fileUrl, destPath, cb, redirects) {
        redirects = redirects || 0;
        if (redirects > 5) return cb(new Error("Too many redirects"));

        let parsed;
        try {
            parsed = new URL(fileUrl);
        } catch (e) {
            return cb(new Error("Invalid URL: " + fileUrl));
        }

        const client = parsed.protocol === "http:" ? http : https;
        const req = client.get(parsed, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();
                const next = new URL(response.headers.location, parsed).toString();
                return downloadFile(next, destPath, cb, redirects + 1);
            }
            if (response.statusCode !== 200) {
                response.resume();
                return cb(new Error("Download failed with HTTP " + response.statusCode));
            }
            const file = fs.createWriteStream(destPath);
            response.pipe(file);
            file.on("finish", () => file.close(() => cb(null)));
            file.on("error", (err) => {
                fs.unlink(destPath, () => {});
                cb(err);
            });
        });
        req.on("error", (err) => cb(err));
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
        node.distro = config.distro;
        node.sourceType = config.sourceType || "existing";
        node.sourceFile = config.sourceFile;
        node.sourceRelease = config.sourceRelease;
        node.installLocation = config.installLocation;
        node.imageLocation = config.imageLocation;
        node.provisionStatus = "checking";
        node.provisionDetail = "";

        function handleProvisionEvent(phase, detail) {
            node.provisionStatus = phase;
            node.provisionDetail = detail || "";
            if (phase === "error") {
                node.error('WSL provisioning of "' + node.distro + '" failed: ' + node.provisionDetail);
            }
            node.emit("wsl-provision", { status: phase, detail: node.provisionDetail });
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
                report("ready");
            });
        }

        function provision(report) {
            const installLocation = node.installLocation || path.join(os.homedir(), "wsl", node.distro);

            if (node.sourceType === "file") {
                if (!node.sourceFile) {
                    return report("error", "Source image file is not set");
                }
                if (!fs.existsSync(node.sourceFile)) {
                    return report("error", "Source file does not exist: " + node.sourceFile);
                }
                importImage(node.sourceFile, installLocation, report);
                return;
            }

            // sourceType === "download"
            const image = UBUNTU_WSL_IMAGES[node.sourceRelease];
            if (!image) {
                return report("error", "Unknown Ubuntu release: " + (node.sourceRelease || "(not set)"));
            }
            const url = image[hostArch()];
            if (!url) {
                return report("error", "No " + node.sourceRelease + " image available for architecture " + hostArch());
            }

            // If an image folder is configured the downloaded .tar.gz is kept
            // there and reused on later imports; otherwise a temporary file is
            // used and deleted afterwards.
            const keepImage = !!node.imageLocation;
            const imageDir = node.imageLocation || os.tmpdir();
            try {
                fs.mkdirSync(imageDir, { recursive: true });
            } catch (e) {
                return report("error", "Failed to create image folder: " + e.message);
            }
            const fileName = path.basename(new URL(url).pathname);
            const imagePath = keepImage
                ? path.join(imageDir, fileName)
                : path.join(imageDir, "wsl-" + Date.now() + "-" + fileName);

            if (keepImage && fs.existsSync(imagePath)) {
                node.log("Reusing downloaded image: " + imagePath);
                importImage(imagePath, installLocation, report);
                return;
            }

            report("downloading");
            downloadFile(url, imagePath, (err) => {
                if (err) {
                    fs.unlink(imagePath, () => {});
                    return report("error", "Download failed: " + err.message);
                }
                importImage(imagePath, installLocation, (phase, detail) => {
                    if (!keepImage && (phase === "ready" || phase === "error")) {
                        fs.unlink(imagePath, () => {});
                    }
                    report(phase, detail);
                });
            });
        }

        if (!node.distro) {
            handleProvisionEvent("error", "Distro name is not set");
        } else if (inflightProvisions[node.distro]) {
            const op = inflightProvisions[node.distro];
            op.subscribers.push(handleProvisionEvent);
            handleProvisionEvent(op.phase, op.detail);
        } else {
            listDistros((err, distros) => {
                if (!err && distros.some((d) => d.name === node.distro)) {
                    return handleProvisionEvent("ready");
                }
                if (node.sourceType === "file" || node.sourceType === "download") {
                    node.log('Provisioning WSL distribution "' + node.distro + '" (' + node.sourceType + ')');
                    startProvision(node.distro, handleProvisionEvent, provision);
                } else if (err) {
                    node.warn("Could not verify WSL distributions: " + err.message);
                    handleProvisionEvent("ready");
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

            // Deleting the config node also removes the WSL distribution it
            // created. Distributions merely referenced (sourceType "existing")
            // are left untouched.
            if (removed && node.distro && (node.sourceType === "file" || node.sourceType === "download")) {
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

    // Catalog of downloadable clean Ubuntu images, filtered to the host architecture.
    RED.httpAdmin.get("/wsl-config/images", function (req, res) {
        const arch = hostArch();
        const images = Object.keys(UBUNTU_WSL_IMAGES).map((key) => ({
            key: key,
            label: UBUNTU_WSL_IMAGES[key].label,
            available: !!UBUNTU_WSL_IMAGES[key][arch]
        }));
        res.json({ arch: arch, images: images });
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

        const rmCmd = `rmdir /s /q "${folderPath}"`;
        exec(rmCmd, { windowsHide: true, timeout: 30000 }, (error, stdout, stderr) => {
            if (error) {
                return res.status(500).json({ error: stderr || error.message });
            }
            res.json({ message: "Folder deleted successfully" });
        });
    });
};
