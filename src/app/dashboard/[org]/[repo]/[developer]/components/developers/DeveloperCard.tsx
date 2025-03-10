"use client";
import { type Developer } from "~/types";

export const DeveloperCard: React.FC<{
  developer: Developer;
  onSelectDeveloper: (developer: Developer) => void;
}> = ({ developer, onSelectDeveloper }) => {
  return (
    <div className="m-8 mx-auto flex w-96 flex-col items-center justify-center rounded-2xl bg-white p-4 shadow-lg transition duration-300 hover:shadow-2xl">
      <div className="relative -mt-16 h-32 w-32 overflow-hidden rounded-full border-4 border-white shadow-md">
        <img
          src={developer.imageUrl}
          alt={`${developer.name}'s profile`}
          className="h-full w-full object-cover"
        />
      </div>
      <div className="mt-4 w-full px-4">
        <h2 className="text-center text-2xl font-semibold text-gray-900">
          {developer.name}
        </h2>
        <p className="text-center text-indigo-500">{developer.location}</p>
        <p className="mt-2 text-center text-sm text-gray-500">
          {developer.bio}
        </p>
      </div>
      <div className="mt-6 w-full">
        <button
          onClick={() => onSelectDeveloper(developer)}
          className="flex w-full items-center justify-center rounded-lg bg-dark-blue px-6 py-3 text-center text-sm font-medium text-white shadow-md transition duration-300 ease-in-out hover:bg-indigo-700"
        >
          {developer.cta}
        </button>
      </div>
    </div>
  );
};

export default DeveloperCard;
