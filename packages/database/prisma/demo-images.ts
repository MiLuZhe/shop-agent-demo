const paths = (...ids: number[]) => ids.map((id) => `/demo-media/pexels-${id}.jpg`);
const mouse = paths(7265965, 13211073, 8250832);
const bottle = paths(2832062, 15653319, 11763619);
const notebook = paths(1119792, 5594320, 7657592);
export const demoProductImages = [
  { id: '00000000-0000-4000-8000-000000000100', name: '轻行无线鼠标', imageUrls: mouse },
  { id: '00000000-0000-4000-8000-000000000101', name: '随行保温杯', imageUrls: bottle },
  { id: '00000000-0000-4000-8000-000000000102', name: '留白笔记本', imageUrls: notebook },
  { id: '00000000-0000-4000-8000-000000000103', name: '轻旅收纳包', imageUrls: paths(9846607, 7614386) },
  { id: '00000000-0000-4000-8000-000000000104', name: '折叠充电器', imageUrls: paths(35921904, 21854466) },
  { id: '00000000-0000-4000-8000-000000000106', name: '磁吸折叠手机支架', imageUrls: paths(4526428) },
  { id: '00000000-0000-4000-8000-000000000107', name: '随行咖啡保温杯', imageUrls: paths(19155039, 7734745) },
  { id: '00000000-0000-4000-8000-000000000108', name: '旅行分装收纳盒', imageUrls: paths(10813691) },
  { id: '00000000-0000-4000-8000-000000000109', name: '点阵便携笔记本', imageUrls: notebook },
  { id: '678a0413-8752-46df-9a6d-778770ddee73', name: '笔记本电脑', imageUrls: paths(32966915, 19894902) },
];
