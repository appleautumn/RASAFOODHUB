-- 收据上的付款方式：QR / 卡 / 现金。
--
-- 为什么要单独一栏而不是塞进 notes：核实的时候要知道该去哪个系统对帐 ——
-- QR 跟刷卡在 FINEXUS 那边是两条不同的纪录。塞在备注里，人得先读一段字
-- 才知道要查哪边，而且筛选不了。
--
-- 值只会是 '', 'qr', 'card', 'cash' 四种之一。刻意不加 CHECK：
-- 之后多一种付款方式时，改资料库比改一个 CHECK 约束容易得多。

ALTER TABLE customers ADD COLUMN payment_type TEXT NOT NULL DEFAULT '';
