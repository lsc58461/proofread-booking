/**
 * 차단 중일 때 보여줄 화면. 브라우저 기본 404 와 같은 모습으로 두어
 * 페이지가 존재하지 않는 것처럼 보이게 한다.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-white">
      <div className="flex items-center">
        <h1 className="mr-5 border-r border-black/30 pr-6 text-2xl font-medium text-black">404</h1>
        <h2 className="text-sm font-normal text-black">This page could not be found.</h2>
      </div>
    </div>
  );
}
