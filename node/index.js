#!/usr/bin/env node

const { program } = require("commander");
const sqlite3 = require("sqlite3").verbose();
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const turf = require("@turf/turf");

class TileDownloader {
  constructor(options) {
    // 1. 模式优先级判定：坐标模式优先级高于 GeoJSON
    if (options.topLeft && options.bottomRight) {
      this.geoJson = null;
      this.targetGeometry = null;
      this.geoBBox = null;
      this.topLeft = options.topLeft;
      this.bottomRight = options.bottomRight;
      console.log(`[Info] 模式: 矩形范围模式`);
    } else {
      this.geoJson = options.geoJson || this.loadDefaultGeoJson();
      this.targetGeometry = null;
      this.geoBBox = null;
      if (this.geoJson) {
        console.log(`[Info] 模式: GeoJSON 边界模式 (正在预处理...)`);
        const combined = turf.combine(this.geoJson);
        this.targetGeometry = combined.features[0];
        this.geoBBox = turf.bbox(this.geoJson);
      }
      console.log(`[Info] 模式: GeoJSON 模式`);
    }

    this.minZoom = parseInt(options.minZoom) || 0;
    this.maxZoom = parseInt(options.maxZoom);
    this.urlTemplate = options.urlTemplate;
    this.outputFile = options.outputFile;
    this.concurrency = parseInt(options.concurrency) || 10;
    this.batchSize = parseInt(options.batchSize) || 500;
    this.retryLimit = 3;

    if (!this.outputFile) throw new Error("输出文件名不能为空");
  }

  loadDefaultGeoJson() {
    const defaultPath = path.join(__dirname, "china.geojson");
    if (fs.existsSync(defaultPath)) {
      return JSON.parse(fs.readFileSync(defaultPath, "utf-8"));
    }
    return null;
  }

  deg2num(lat, lon, zoom) {
    // 关键修复：Web Mercator 投影纬度裁剪，防止 tan(90) 导致 Infinity
    const safeLat = Math.max(-85.0511, Math.min(85.0511, lat));
    const lat_rad = (safeLat * Math.PI) / 180;
    const n = Math.pow(2, zoom);
    let x = Math.floor(((lon + 180) / 360) * n);
    let y = Math.floor(
      ((1 - Math.log(Math.tan(lat_rad) + 1 / Math.cos(lat_rad)) / Math.PI) /
        2) *
        n,
    );
    return {
      x: Math.max(0, Math.min(n - 1, x)),
      y: Math.max(0, Math.min(n - 1, y)),
    };
  }

  num2deg(x, y, z) {
    const n = Math.pow(2, z);
    const lon_deg = (x / n) * 360 - 180;
    const lat_rad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
    const lat_deg = (lat_rad * 180) / Math.PI;
    return [lon_deg, lat_deg];
  }

  async downloadTileWithRetry(tile) {
    const url = this.urlTemplate
      .replace("{z}", tile.z)
      .replace("{x}", tile.x)
      .replace("{y}", tile.y);
    for (let i = 0; i < this.retryLimit; i++) {
      try {
        const res = await axios.get(url, {
          responseType: "arraybuffer",
          timeout: 15000,
        });
        return { ...tile, data: res.data, success: true };
      } catch (e) {
        if (i === this.retryLimit - 1) return { ...tile, success: false };
      }
    }
  }

  *tileGenerator(zoom) {
    let xMin, xMax, yMin, yMax;
    if (this.geoBBox) {
      const tl = this.deg2num(this.geoBBox[3], this.geoBBox[0], zoom);
      const br = this.deg2num(this.geoBBox[1], this.geoBBox[2], zoom);
      xMin = Math.min(tl.x, br.x);
      xMax = Math.max(tl.x, br.x);
      yMin = Math.min(tl.y, br.y);
      yMax = Math.max(tl.y, br.y);
    } else {
      const tl = this.deg2num(this.topLeft.lat, this.topLeft.lng, zoom);
      const br = this.deg2num(this.bottomRight.lat, this.bottomRight.lng, zoom);
      xMin = Math.min(tl.x, br.x);
      xMax = Math.max(tl.x, br.x);
      yMin = Math.min(tl.y, br.y);
      yMax = Math.max(tl.y, br.y);
    }

    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        if (this.targetGeometry) {
          const pt = turf.point(this.num2deg(x + 0.5, y + 0.5, zoom));
          if (!turf.booleanPointInPolygon(pt, this.targetGeometry)) continue;
        }
        yield { z: zoom, x, y };
      }
    }
  }

  async createMBTilesDatabase() {
    return new Promise((resolve) => {
      const db = new sqlite3.Database(this.outputFile);
      db.serialize(() => {
        // --- 修改点 1: 回退模式 ---
        // 使用 DELETE 模式替代 WAL，避免生成额外的 -shm 和 -wal 辅助文件
        // 这能显著提高在 Docker 或网络挂载环境下的兼容性
        db.run("PRAGMA journal_mode = DELETE");

        // 保持同步模式为 OFF 以确保下载速度，但在最终 close 前我们会恢复它
        db.run("PRAGMA synchronous = OFF");

        db.run(
          "CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT)",
        );
        db.run(
          "CREATE TABLE IF NOT EXISTS tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB, PRIMARY KEY (zoom_level, tile_column, tile_row))",
        );

        let b = "-180,-85,180,85";
        if (this.geoBBox) b = this.geoBBox.join(",");
        else if (this.topLeft)
          b = `${this.topLeft.lng},${this.bottomRight.lat},${this.bottomRight.lng},${this.topLeft.lat}`;

        const meta = [
          ["name", path.basename(this.outputFile, ".mbtiles")],
          ["format", "png"], // 确保 Martin 识别格式
          ["bounds", b],
          ["minzoom", String(this.minZoom)],
          ["maxzoom", String(this.maxZoom)],
          ["type", "overlay"], // 补充元数据建议
          ["version", "1.1"],
        ];
        const stmt = db.prepare(
          "INSERT OR REPLACE INTO metadata (name, value) VALUES (?, ?)",
        );
        meta.forEach((m) => stmt.run(m[0], m[1]));
        stmt.finalize(() => resolve(db));
      });
    });
  }

  async insertTilesBatch(db, tiles) {
    if (tiles.length === 0) return 0;
    return new Promise((resolve) => {
      db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        const stmt = db.prepare(
          "INSERT OR REPLACE INTO tiles VALUES (?, ?, ?, ?)",
        );
        tiles.forEach((t) => {
          // 关键修复：MBTiles 使用 TMS 坐标系 (Y轴翻转)
          const tmsY = Math.pow(2, t.z) - 1 - t.y;
          stmt.run(t.z, t.x, tmsY, t.data);
        });
        stmt.finalize(() => db.run("COMMIT", () => resolve(tiles.length)));
      });
    });
  }

  async download() {
    const db = await this.createMBTilesDatabase();
    let totalSavedGlobal = 0;
    const globalStartTime = Date.now();

    for (let zoom = this.minZoom; zoom <= this.maxZoom; zoom++) {
      console.log(`\n── Zoom ${zoom} ──`);

      // 快速估算总数用于进度条
      let estInZoom = 1;
      const ref = this.geoBBox || {
        0: this.topLeft.lng,
        1: this.bottomRight.lat,
        2: this.bottomRight.lng,
        3: this.topLeft.lat,
      };
      const tl = this.deg2num(ref[3], ref[0], zoom);
      const br = this.deg2num(ref[1], ref[2], zoom);
      estInZoom = Math.max(
        1,
        (Math.abs(br.x - tl.x) + 1) * (Math.abs(br.y - tl.y) + 1),
      );

      const gen = this.tileGenerator(zoom);
      let processedInZoom = 0;
      let finished = false;

      while (!finished) {
        let batch = [];
        for (let i = 0; i < this.batchSize; i++) {
          const { value, done } = gen.next();
          if (done) {
            finished = true;
            break;
          }
          batch.push(value);
        }

        if (batch.length > 0) {
          const successful = [];
          const workers = Array(this.concurrency)
            .fill()
            .map(async () => {
              while (batch.length > 0) {
                const t = batch.shift();
                if (!t) break;
                const res = await this.downloadTileWithRetry(t);
                if (res.success) successful.push(res);
              }
            });
          await Promise.all(workers);

          const saved = await this.insertTilesBatch(db, successful);
          // 原始版本优秀习惯：释放 Buffer 内存
          successful.forEach((t) => (t.data = null));

          totalSavedGlobal += saved;
          processedInZoom +=
            batch.length === 0 ? successful.length : this.batchSize; // 简化估算

          const mem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
          const speed = (
            totalSavedGlobal /
            ((Date.now() - globalStartTime) / 1000)
          ).toFixed(1);
          console.log(
            `[Z${zoom}] 进度: ~${((processedInZoom / estInZoom) * 100).toFixed(1)}% | 已存: ${totalSavedGlobal} | 均速: ${speed}t/s | 内存: ${mem}MB`,
          );
        }
      }
    }

    console.log("\n正在优化数据库结构...");
    db.run("PRAGMA synchronous = NORMAL"); // 恢复同步模式以确保安全
    db.run("VACUUM", () => {
      db.close(async (err) => {
        if (err) console.error("关闭数据库失败:", err.message);
        console.log(
          `\n✅ 任务完成！总计保存: ${totalSavedGlobal.toLocaleString()}`,
        );
        if (this.convertToPMTiles) await this.tryConvertToPMTiles();
      });
    });
  }

  async tryConvertToPMTiles() {
    const outputPmtiles = this.outputFile.replace(/\.mbtiles$/i, ".pmtiles");
    const cmd = fs.existsSync(this.pmtilesPath) ? this.pmtilesPath : "pmtiles";
    return new Promise((resolve) => {
      console.log(`\n📦 格式转换中...`);
      const child = spawn(cmd, ["convert", this.outputFile, outputPmtiles]);
      child.stdout.on("data", (data) =>
        process.stdout.write(`[pmtiles] ${data}`),
      );
      child.on("close", resolve);
    });
  }
}

// ───── 保留您原有的测试渲染逻辑 ─────
class MBTilesTester {
  constructor(inputFile, outputFile) {
    this.inputFile = inputFile;
    this.outputFile = outputFile;
  }
  async getMaxZoomLevel() {
    return new Promise((r, e) => {
      const db = new sqlite3.Database(this.inputFile);
      db.get("SELECT MAX(zoom_level) as mz FROM tiles", (err, row) => {
        db.close();
        err ? e(err) : r(row?.mz || 0);
      });
    });
  }
  async getTilesForZoom(z) {
    return new Promise((r, e) => {
      const db = new sqlite3.Database(this.inputFile);
      db.all(
        "SELECT tile_column, tile_row, tile_data FROM tiles WHERE zoom_level = ? LIMIT 100",
        [z],
        (err, rows) => {
          db.close();
          err ? e(err) : r(rows);
        },
      );
    });
  }
  mbRowToY(row, zoom) {
    return Math.pow(2, zoom) - 1 - row;
  }
  async renderImage() {
    const maxZ = await this.getMaxZoomLevel();
    const tiles = await this.getTilesForZoom(maxZ);
    if (!tiles || tiles.length === 0) {
      console.log("No tiles found for testing.");
      return;
    }
    const ts = 256;
    const xs = tiles.map((t) => t.tile_column);
    const ys = tiles.map((t) => this.mbRowToY(t.tile_row, maxZ));
    const w = (Math.max(...xs) - Math.min(...xs) + 1) * ts;
    const h = (Math.max(...ys) - Math.min(...ys) + 1) * ts;

    console.log(`Rendering test image: ${w}x${h}...`);
    const img = new Jimp(w, h, 0xf0f0f0ff);
    for (const t of tiles) {
      const x = (t.tile_column - Math.min(...xs)) * ts;
      const y = (this.mbRowToY(t.tile_row, maxZ) - Math.min(...ys)) * ts;
      try {
        const tileImg = await Jimp.read(Buffer.from(t.tile_data));
        img.composite(tileImg, x, y);
      } catch (err) {
        console.error("Tile render error:", err.message);
      }
    }
    await img.writeAsync(this.outputFile);
    console.log(`Test image saved to -> ${this.outputFile}`);
  }
}

// ───── CLI 命令定义 ─────
program.name("2maps-loader").version("1.8.2");
program
  .command("download")
  .option("--geojson <path>", "GeoJSON 路径")
  .option("--corner1 <lat,lng>", "左上角")
  .option("--corner2 <lat,lng>", "右下角")
  .option("--min-zoom <number>", "最小层级", "0")
  .requiredOption("--max-zoom <number>", "最大层级")
  .requiredOption("--url-template <url>")
  .requiredOption("--output <file>")
  .option("--concurrency <n>", "并发数", "10")
  .option("--batch-size <n>", "批次大小", "1000")
  .option("--convert-pmtiles", "自动转换")
  .action(async (opts) => {
    let geoJson = null,
      tl = null,
      br = null;

    // --- 增加防御性代码：去除可能存在的换行符或空格 ---
    const output = opts.output ? opts.output.trim() : null;
    const urlTemplate = opts.urlTemplate ? opts.urlTemplate.trim() : null;

    // 逻辑调整：如果传入了坐标，则不加载 GeoJSON
    if (opts.corner1 && opts.corner2) {
      const c1 = opts.corner1.split(",").map(Number);
      const c2 = opts.corner2.split(",").map(Number);
      tl = { lat: Math.max(c1[0], c2[0]), lng: Math.min(c1[1], c2[1]) };
      br = { lat: Math.min(c1[0], c2[0]), lng: Math.max(c1[1], c2[1]) };
      console.log(`[Info] 检测到坐标输入，将使用矩形模式。`);
    } else if (opts.geojson && fs.existsSync(opts.geojson)) {
      geoJson = JSON.parse(fs.readFileSync(opts.geojson, "utf-8"));
    }

    const downloader = new TileDownloader({
      geoJson,
      topLeft: tl,
      bottomRight: br,
      minZoom: opts.minZoom,
      maxZoom: opts.maxZoom,
      urlTemplate: urlTemplate, // 使用处理后的 urlTemplate
      outputFile: output, // 使用处理后的 output
      concurrency: opts.concurrency,
      batchSize: opts.batchSize,
      convertToPMTiles: opts.convertPmtiles,
    });

    await downloader.download();
  });

program
  .command("test")
  .requiredOption("--input <file>")
  .requiredOption("--output <file>")
  .action(async (opts) => {
    try {
      const tester = new MBTilesTester(opts.input, opts.output);
      await tester.renderImage();
    } catch (e) {
      console.error("Test Error:", e.message);
    }
  });

program.parse();
