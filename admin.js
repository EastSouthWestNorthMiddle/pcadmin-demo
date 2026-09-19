/* PC 管理端 · 交互逻辑（task-48 精简版 MVP）
 *
 * 对接 Charlie admin 模块 3 端点（08-17 交付，契约零分歧）：
 *   GET  /admin/products
 *   PUT  /admin/products/:id/status
 *   GET  /admin/suppliers
 *
 * Charlie 报备的 2 项 TODO 前端兜底：
 *   1. stock 恒返 0（商品目录无库存字段）→ 显示「—」而非「0」，避免运营误判售罄
 *   2. mainImage 可为 null → 用 emoji 占位块，避免 <img src=null> 脏请求
 */

/**
 * API 基址（含路径前缀）
 *
 * ⚠️ 实测修正（Alice 08-17 12:41 本地联调取证）：
 *   admin 实际路由 /api/admin/*，**不带 v1**：
 *     Mapped {/api/admin/products, GET}
 *     Mapped {/api/admin/products/:id/status, PUT}
 *     Mapped {/api/admin/suppliers, GET}
 *   来源：main.ts:126 setGlobalPrefix('api') + admin.controller.ts:46 @Controller('admin')
 *   而 supplier 为 @Controller('v1/supplier') → /api/v1/supplier/*
 *
 *   契约文档 v0.1 写的 /admin/* 缺 /api 前缀，按实测已修正。
 *   留空走内置 mock。
 */
// 路由前缀：/api/admin/*（不含 v1）—— 08-17 12:41 实测确认
//   依据 main.ts:126 setGlobalPrefix('api') + admin.controller.ts:46 @Controller('admin')
//   Manager 08-17 17:2x 终裁：08-20 前不动任何路由，REST 版本段统一列 Q4 技术债
//   （15 controller 两派分裂：6 有 v1 / 9 无 v1，非 admin 特例）→ 本文件无待办
var API_BASE = '';  // Netlify 演示版：留空走内置 mock

/**
 * JWT token（admin 三端点均为类级 @UseGuards(JwtAuthGuard)，无 @Public，不带则 401）
 *
 * 联调期获取方式（Manager 裁决 ④ 批准）：
 *   cd backend-service && node scripts/gen-dev-token.js cust_alice 24h
 *
 * ⚠️ 边界限定（裁决 ④）：仅限本地/联调，禁止进 staging/生产；JWT_SECRET 不得提交仓库。
 * ⚠️ 本变量也不得填入真实 token 后提交——本地跑时临时赋值或从 localStorage 读。
 */
var AUTH_TOKEN = (typeof localStorage !== 'undefined' && localStorage.getItem('dev_token')) || '';

/** 统一请求头：有 token 则带 Authorization */
function authHeaders(extra) {
  var h = extra || {};
  if (AUTH_TOKEN) h['Authorization'] = 'Bearer ' + AUTH_TOKEN;
  return h;
}

/** 统一响应处理：401 给明确提示（而非笼统“加载失败”） */
function handleRes(r) {
  if (r.status === 401) {
    throw new Error('401 未授权：请执行 node scripts/gen-dev-token.js cust_alice 24h，并在控制台运行 localStorage.setItem("dev_token", "<token>") 后刷新');
  }
  if (!r.ok) {
    return r.json().then(function (e) { throw new Error(e.message || ('HTTP ' + r.status)); });
  }
  return r.json().then(function (j) { return j.data || j; });
}

/* ============ 状态 ============ */
var state = {
  view: 'products',
  products: { list: [], total: 0, pageNo: 1, pageSize: 10, hasMore: false },
  suppliers: { list: [], total: 0, pageNo: 1, pageSize: 10, hasMore: false },
  supplierOptions: []
};

/* ============ 工具 ============ */
function $(id) { return document.getElementById(id); }

function toast(msg, isErr) {
  var t = $('toast');
  t.textContent = msg;
  t.className = 'toast show ' + (isErr ? 'err' : 'ok');
  setTimeout(function () { t.className = 'toast'; }, 2400);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * stock 渲染
 *
 * 口径（Manager 裁决 ② · 08-17 12:25）：
 *   本期保持后端返 0 + 前端渲染「—」，不改后端。
 *   理由：改 null 要动前后端两侧 + 测试，收益是语义纯度、代价是返工风险，压缩期不划算。
 *
 * ⚠️ Q4 技术债（已登记）：Bob 建库存字段时一并改为后端返 null + 前端判 null。
 *    届时才能区分「无库存数据」与「真实 0 库存（售罄）」——
 *    当前两者均渲染「—」是有意为之：后端恒返 0，不存在真实 0 库存场景。
 *    （本函数 12:2x 曾改为判 null，据裁决 ② 已回退，否则后端返 0 会被渲染为「售罄」，语义反转）
 */
function renderStock(stock) {
  if (stock === 0 || stock == null) {
    return '<span class="cell-muted" title="商品目录暂无库存字段（待 Bob 建字段 · Q4 技术债）">—</span>';
  }
  return esc(stock);
}

/** mainImage 兜底：可为 null，用 emoji 占位块避免脏请求 */
function renderThumb(url, name) {
  if (!url) {
    return '<div class="thumb-fallback" title="' + esc(name) + '">🥬</div>';
  }
  return '<img class="thumb" src="' + esc(url) + '" alt="' + esc(name) +
    '" onerror="this.outerHTML=\'<div class=&quot;thumb-fallback&quot;>🥬</div>\'">';
}

function badgeOnSale(onSale) {
  return onSale
    ? '<span class="badge badge-on">已上架</span>'
    : '<span class="badge badge-off">已下架</span>';
}

function badgeSupplier(status) {
  var map = { '合作中': 'badge-active', '暂停': 'badge-paused', '终止': 'badge-ended' };
  return '<span class="badge ' + (map[status] || 'badge-ended') + '">' + esc(status) + '</span>';
}

/* ============ 内置 Mock 数据（联调前用，对齐 Charlie 契约） ============ */
var MOCK_PRODUCTS = [
  { id:'rec-prd-0001', productCode:'SP8-00001', name:'普罗旺斯西红柿', sku:'SP8-TOMATO-LS-001', categoryId:'rec-cat-veg', categoryName:'蔬菜', unit:'斤', price:4.5, stock:0, onSale:true, businessMode:'入驻', cityWarehouseId:'rec-wh-xiamen', cityWarehouseName:'厦门中埔仓', supplierId:'rec-sup-xianfeng', supplierName:'厦门鲜丰蔬菜有限公司', auditStatus:'approved', auditRemark:null, mainImage:null, updatedAt:'2026-08-17 08:00:00' },
  { id:'rec-prd-0002', productCode:'SP8-00002', name:'有机菠菜', sku:'SP8-SPINACH-ORG-001', categoryId:'rec-cat-veg', categoryName:'蔬菜', unit:'斤', price:6.8, stock:0, onSale:true, businessMode:'入驻', cityWarehouseId:'rec-wh-xiamen', cityWarehouseName:'厦门中埔仓', supplierId:'rec-sup-xianfeng', supplierName:'厦门鲜丰蔬菜有限公司', auditStatus:'approved', auditRemark:null, mainImage:null, updatedAt:'2026-08-16 16:00:00' },
  { id:'rec-prd-0003', productCode:'SP8-00003', name:'黄瓜', sku:'SP8-CUCUMBER-001', categoryId:'rec-cat-veg', categoryName:'蔬菜', unit:'斤', price:3.2, stock:0, onSale:false, businessMode:'入驻', cityWarehouseId:'rec-wh-xiamen', cityWarehouseName:'厦门中埔仓', supplierId:'rec-sup-xianfeng', supplierName:'厦门鲜丰蔬菜有限公司', auditStatus:'approved', auditRemark:null, mainImage:null, updatedAt:'2026-08-15 10:00:00' },
  { id:'rec-prd-0004', productCode:'SP8-00004', name:'大白菜', sku:'SP8-CABBAGE-001', categoryId:'rec-cat-veg', categoryName:'蔬菜', unit:'斤', price:2.5, stock:0, onSale:true, businessMode:'入驻', cityWarehouseId:'rec-wh-xiamen', cityWarehouseName:'厦门中埔仓', supplierId:'rec-sup-yangguang', supplierName:'厦门阳光农产', auditStatus:'approved', auditRemark:null, mainImage:null, updatedAt:'2026-08-16 14:00:00' },
  { id:'rec-prd-0005', productCode:'SP8-00005', name:'青椒', sku:'SP8-PEPPER-GREEN-001', categoryId:'rec-cat-veg', categoryName:'蔬菜', unit:'斤', price:7.2, stock:0, onSale:true, businessMode:'入驻', cityWarehouseId:'rec-wh-xiamen', cityWarehouseName:'厦门中埔仓', supplierId:'rec-sup-yangguang', supplierName:'厦门阳光农产', auditStatus:'approved', auditRemark:null, mainImage:null, updatedAt:'2026-08-17 07:00:00' },
  { id:'rec-prd-0006', productCode:'SP8-00006', name:'新鲜猪肉', sku:'SP8-PORK-FRESH-001', categoryId:'rec-cat-meat', categoryName:'肉类', unit:'斤', price:22.0, stock:0, onSale:true, businessMode:'入驻', cityWarehouseId:'rec-wh-xiamen', cityWarehouseName:'厦门中埔仓', supplierId:'rec-sup-fuxiang', supplierName:'厦门福祥肉品', auditStatus:'approved', auditRemark:null, mainImage:null, updatedAt:'2026-08-17 06:00:00' },
  { id:'rec-prd-0007', productCode:'SP8-00007', name:'鸡蛋（30枚/板）', sku:'SP8-EGG-30-001', categoryId:'rec-cat-egg', categoryName:'蛋类', unit:'板', price:25.0, stock:0, onSale:false, businessMode:'入驻', cityWarehouseId:'rec-wh-xiamen', cityWarehouseName:'厦门中埔仓', supplierId:'rec-sup-xianfeng', supplierName:'厦门鲜丰蔬菜有限公司', auditStatus:'approved', auditRemark:null, mainImage:null, updatedAt:'2026-08-14 09:00:00' }
];

var MOCK_SUPPLIERS = [
  { id:'rec-sup-xianfeng', supplierCode:'SPP-00001', name:'厦门鲜丰蔬菜有限公司', contactName:'张三', contactPhone:'13800001111', status:'合作中', cityWarehouseId:'rec-wh-xiamen', cityWarehouseName:'厦门中埔仓', onSaleProductCount:2, createdAt:'2026-01-15 09:00:00' },
  { id:'rec-sup-yangguang', supplierCode:'SPP-00002', name:'厦门阳光农产', contactName:'李四', contactPhone:'13800002222', status:'合作中', cityWarehouseId:'rec-wh-xiamen', cityWarehouseName:'厦门中埔仓', onSaleProductCount:2, createdAt:'2026-03-20 10:00:00' },
  { id:'rec-sup-fuxiang', supplierCode:'SPP-00003', name:'厦门福祥肉品', contactName:'王五', contactPhone:'13800003333', status:'暂停', cityWarehouseId:'rec-wh-xiamen', cityWarehouseName:'厦门中埔仓', onSaleProductCount:1, createdAt:'2026-05-10 08:30:00' },
  { id:'rec-sup-haixian', supplierCode:'SPP-00004', name:'厦门海味水产', contactName:'赵六', contactPhone:'13800004444', status:'合作中', cityWarehouseId:'rec-wh-xiamen', cityWarehouseName:'厦门中埔仓', onSaleProductCount:0, createdAt:'2026-07-01 14:00:00' }
];

var mockProducts = JSON.parse(JSON.stringify(MOCK_PRODUCTS));

/* ============ 数据层（API_BASE 留空走 mock） ============ */
function fetchProducts(query) {
  if (API_BASE) {
    var qs = Object.keys(query).filter(function (k) { return query[k] !== '' && query[k] != null; })
      .map(function (k) { return k + '=' + encodeURIComponent(query[k]); }).join('&');
    return fetch(API_BASE + '/admin/products?' + qs, { headers: authHeaders() })
      .then(handleRes);
  }
  // mock：仅 approved 可见（ADM-3）
  var list = mockProducts.filter(function (p) { return p.auditStatus === 'approved'; });
  if (query.categoryId) list = list.filter(function (p) { return p.categoryId === query.categoryId; });
  if (query.onSale !== '' && query.onSale != null) {
    var want = String(query.onSale) === 'true';
    list = list.filter(function (p) { return p.onSale === want; });
  }
  if (query.supplierId) list = list.filter(function (p) { return p.supplierId === query.supplierId; });
  if (query.keyword) {
    var kw = query.keyword.toLowerCase();
    // ADM-4：keyword 覆盖 name / sku / productCode 三字段
    list = list.filter(function (p) {
      return p.name.toLowerCase().indexOf(kw) >= 0
        || p.sku.toLowerCase().indexOf(kw) >= 0
        || p.productCode.toLowerCase().indexOf(kw) >= 0;
    });
  }
  var pageNo = query.pageNo || 1, pageSize = query.pageSize || 10;
  var start = (pageNo - 1) * pageSize;
  var paged = list.slice(start, start + pageSize);
  return Promise.resolve({ list: paged, total: list.length, pageNo: pageNo, pageSize: pageSize, hasMore: start + paged.length < list.length });
}

function fetchSuppliers(query) {
  if (API_BASE) {
    var qs = Object.keys(query).filter(function (k) { return query[k] !== '' && query[k] != null; })
      .map(function (k) { return k + '=' + encodeURIComponent(query[k]); }).join('&');
    return fetch(API_BASE + '/admin/suppliers?' + qs, { headers: authHeaders() })
      .then(handleRes);
  }
  var list = MOCK_SUPPLIERS.slice();
  if (query.status) list = list.filter(function (s) { return s.status === query.status; });
  if (query.keyword) {
    var kw = query.keyword.toLowerCase();
    list = list.filter(function (s) { return s.name.toLowerCase().indexOf(kw) >= 0; });
  }
  var pageNo = query.pageNo || 1, pageSize = query.pageSize || 10;
  var start = (pageNo - 1) * pageSize;
  var paged = list.slice(start, start + pageSize);
  return Promise.resolve({ list: paged, total: list.length, pageNo: pageNo, pageSize: pageSize, hasMore: start + paged.length < list.length });
}

function updateProductStatus(id, onSale, remark) {
  if (API_BASE) {
    return fetch(API_BASE + '/admin/products/' + id + '/status', {
      method: 'PUT',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ onSale: onSale, remark: remark })
    }).then(handleRes);
  }
  var p = null;
  for (var i = 0; i < mockProducts.length; i++) {
    if (mockProducts[i].id === id) { p = mockProducts[i]; break; }
  }
  if (!p) return Promise.reject(new Error('商品不存在'));
  // ADM-10：非 approved 返 400
  if (p.auditStatus !== 'approved') {
    return Promise.reject(new Error('仅审核通过（approved）的商品可操作上下架'));
  }
  // ADM-9：幂等，同态不写入
  if (p.onSale === onSale) {
    return Promise.resolve({ id: id, onSale: p.onSale, updatedAt: p.updatedAt, idempotent: true });
  }
  p.onSale = onSale;
  p.updatedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
  return Promise.resolve({ id: id, onSale: p.onSale, updatedAt: p.updatedAt });
}

/* ============ 渲染层 ============ */
function renderProducts() {
  var d = state.products;
  var box = $('products-body');

  if (!d.list.length) {
    box.innerHTML = '<div class="empty">暂无符合条件的商品</div>';
    $('products-pager').innerHTML = '';
    return;
  }

  var rows = d.list.map(function (p) {
    return '<tr>'
      + '<td>' + renderThumb(p.mainImage, p.name) + '</td>'
      + '<td><div class="cell-name">' + esc(p.name) + '</div>'
        + '<div class="cell-sub">' + esc(p.sku) + '</div></td>'
      + '<td>' + esc(p.productCode) + '</td>'
      + '<td>' + esc(p.categoryName) + '</td>'
      + '<td class="cell-price">¥' + p.price.toFixed(2) + '<span class="cell-muted">/' + esc(p.unit) + '</span></td>'
      + '<td>' + renderStock(p.stock) + '</td>'
      + '<td>' + esc(p.supplierName) + '</td>'
      + '<td>' + badgeOnSale(p.onSale) + '</td>'
      + '<td class="cell-muted">' + esc(p.updatedAt) + '</td>'
      + '<td>' + (p.onSale
        ? '<button class="btn btn-danger" data-act="off" data-id="' + p.id + '">下架</button>'
        : '<button class="btn btn-primary" data-act="on" data-id="' + p.id + '">上架</button>')
      + '</td>'
    + '</tr>';
  }).join('');

  box.innerHTML = '<table><thead><tr>'
    + '<th>主图</th><th>商品名 / SKU</th><th>编号</th><th>品类</th>'
    + '<th>售价</th><th>库存</th><th>供应商</th><th>状态</th><th>更新时间</th><th>操作</th>'
    + '</tr></thead><tbody>' + rows + '</tbody></table>';

  renderPager('products-pager', d, function (pageNo) {
    state.products.pageNo = pageNo;
    loadProducts();
  });
}

function renderSuppliers() {
  var d = state.suppliers;
  var box = $('suppliers-body');

  if (!d.list.length) {
    box.innerHTML = '<div class="empty">暂无符合条件的供应商</div>';
    $('suppliers-pager').innerHTML = '';
    return;
  }

  var rows = d.list.map(function (s) {
    return '<tr>'
      + '<td>' + esc(s.supplierCode) + '</td>'
      + '<td class="cell-name">' + esc(s.name) + '</td>'
      + '<td>' + esc(s.contactName) + '<div class="cell-sub">' + esc(s.contactPhone) + '</div></td>'
      + '<td>' + badgeSupplier(s.status) + '</td>'
      + '<td>' + esc(s.cityWarehouseName) + '</td>'
      + '<td>' + (s.onSaleProductCount > 0
        ? '<strong>' + s.onSaleProductCount + '</strong>'
        : '<span class="cell-muted">0</span>') + '</td>'
      + '<td class="cell-muted">' + esc(s.createdAt) + '</td>'
    + '</tr>';
  }).join('');

  box.innerHTML = '<table><thead><tr>'
    + '<th>编号</th><th>供应商名称</th><th>联系人</th><th>合作状态</th>'
    + '<th>城市仓</th><th>在售商品数</th><th>入驻时间</th>'
    + '</tr></thead><tbody>' + rows + '</tbody></table>';

  renderPager('suppliers-pager', d, function (pageNo) {
    state.suppliers.pageNo = pageNo;
    loadSuppliers();
  });
}

function renderPager(elId, d, onJump) {
  var totalPages = Math.max(1, Math.ceil(d.total / d.pageSize));
  var html = '<span class="total">共 ' + d.total + ' 条 / ' + totalPages + ' 页</span>';
  html += '<button data-page="' + (d.pageNo - 1) + '"' + (d.pageNo <= 1 ? ' disabled' : '') + '>‹</button>';
  for (var i = 1; i <= totalPages; i++) {
    html += '<button class="' + (i === d.pageNo ? 'cur' : '') + '" data-page="' + i + '">' + i + '</button>';
  }
  html += '<button data-page="' + (d.pageNo + 1) + '"' + (!d.hasMore ? ' disabled' : '') + '>›</button>';

  var el = $(elId);
  el.innerHTML = html;
  el.onclick = function (e) {
    var btn = e.target.closest('button[data-page]');
    if (!btn || btn.disabled) return;
    var page = parseInt(btn.getAttribute('data-page'), 10);
    if (page >= 1 && page <= totalPages && page !== d.pageNo) onJump(page);
  };
}

/* ============ 加载 ============ */
function loadProducts() {
  $('products-body').innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  fetchProducts({
    pageNo: state.products.pageNo,
    pageSize: state.products.pageSize,
    categoryId: $('f-category').value,
    onSale: $('f-onsale').value,
    supplierId: $('f-supplier').value,
    keyword: $('f-keyword').value.trim()
  }).then(function (d) {
    state.products = d;
    renderProducts();
  }).catch(function (e) {
    $('products-body').innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>';
    toast('商品列表加载失败', true);
  });
}

function loadSuppliers() {
  $('suppliers-body').innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  fetchSuppliers({
    pageNo: state.suppliers.pageNo,
    pageSize: state.suppliers.pageSize,
    status: $('s-status').value,
    keyword: $('s-keyword').value.trim()
  }).then(function (d) {
    state.suppliers = d;
    renderSuppliers();
    // 首次加载填充商品页的供应商下拉
    if (!state.supplierOptions.length) {
      state.supplierOptions = MOCK_SUPPLIERS;
      var sel = $('f-supplier');
      MOCK_SUPPLIERS.forEach(function (s) {
        var o = document.createElement('option');
        o.value = s.id; o.textContent = s.name;
        sel.appendChild(o);
      });
    }
  }).catch(function (e) {
    $('suppliers-body').innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>';
    toast('供应商列表加载失败', true);
  });
}

/* ============ 事件 ============ */
document.querySelector('.nav').addEventListener('click', function (e) {
  var item = e.target.closest('.nav-item');
  if (!item) return;
  var view = item.getAttribute('data-view');
  state.view = view;
  document.querySelectorAll('.nav-item').forEach(function (n) { n.classList.remove('active'); });
  item.classList.add('active');
  document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('active'); });
  $('view-' + view).classList.add('active');
  $('pageTitle').textContent = view === 'products' ? '商品管理' : '供应商管理';
});

$('btn-search').onclick = function () { state.products.pageNo = 1; loadProducts(); };
$('btn-reset').onclick = function () {
  $('f-category').value = ''; $('f-onsale').value = '';
  $('f-supplier').value = ''; $('f-keyword').value = '';
  state.products.pageNo = 1; loadProducts();
};
$('f-keyword').onkeydown = function (e) { if (e.key === 'Enter') $('btn-search').click(); };

$('btn-s-search').onclick = function () { state.suppliers.pageNo = 1; loadSuppliers(); };
$('btn-s-reset').onclick = function () {
  $('s-status').value = ''; $('s-keyword').value = '';
  state.suppliers.pageNo = 1; loadSuppliers();
};
$('s-keyword').onkeydown = function (e) { if (e.key === 'Enter') $('btn-s-search').click(); };

/* 上下架操作（事件委托） */
$('products-body').addEventListener('click', function (e) {
  var btn = e.target.closest('button[data-act]');
  if (!btn) return;
  var id = btn.getAttribute('data-id');
  var toOn = btn.getAttribute('data-act') === 'on';

  btn.disabled = true;
  updateProductStatus(id, toOn, toOn ? '管理端上架' : '管理端下架')
    .then(function (r) {
      // ADM-9 幂等：同态请求也算成功
      toast(r.idempotent
        ? (toOn ? '商品已是上架状态' : '商品已是下架状态')
        : (toOn ? '上架成功' : '下架成功'));
      loadProducts();
    })
    .catch(function (err) {
      btn.disabled = false;
      toast(err.message || '操作失败', true);
    });
});

/* ============ 初始化 ============ */
loadSuppliers();
loadProducts();
